"""CLIP's byte-pair tokenizer, implemented directly.

Same reasoning as face_engine: a search box should not drag in `transformers`
or `tokenizers` and their build story on every platform the desktop app ships
to. The vocabulary and merge list are read out of the tokenizer.json that comes
down with the model, so there is nothing here but the algorithm.

The pipeline is fixed by the file itself — NFC, collapse whitespace, lowercase;
split on CLIP's pattern; map bytes to printable characters; then BPE with a
`</w>` marker on the final symbol of every word. Get any step wrong and nothing
raises: the text tower returns a confident vector for the wrong sentence.
"""
import json
import re
import unicodedata
from functools import lru_cache
from pathlib import Path


@lru_cache(maxsize=1)
def _byte_encoder() -> dict[int, str]:
    """GPT-2's byte -> printable-character map, which CLIP inherited.

    Every byte needs a character BPE can hold, but the control and whitespace
    bytes have none of their own, so they are lifted into an unused block."""
    bs = (list(range(ord("!"), ord("~") + 1))
          + list(range(ord("¡"), ord("¬") + 1))
          + list(range(ord("®"), ord("ÿ") + 1)))
    cs = bs[:]
    n = 0
    for b in range(256):
        if b not in bs:
            bs.append(b)
            cs.append(256 + n)
            n += 1
    return {b: chr(c) for b, c in zip(bs, cs)}


def _pairs(word: tuple[str, ...]) -> set[tuple[str, str]]:
    return {(word[i], word[i + 1]) for i in range(len(word) - 1)}


class ClipTokenizer:
    # CLIP's own split pattern, in the dialect `re` speaks. The original is
    # written with \p{L} and \p{N}, which needs the third-party `regex`
    # module; [^\W\d_] is the same set of letters, and \d the same digits.
    # The one divergence is a run mixing underscores with other punctuation,
    # which splits here and would not there — no query anyone types.
    _PAT = re.compile(r"""'s|'t|'re|'ve|'m|'ll|'d|[^\W\d_]+|\d|[^\s\w]+|_+""")

    def __init__(self, tokenizer_json: str | Path, context_len: int = 77):
        spec = json.loads(Path(tokenizer_json).read_text())["model"]
        self.vocab: dict[str, int] = spec["vocab"]
        merges = spec["merges"]
        # tokenizer.json writes a merge as "a b" in older files and ["a", "b"]
        # in newer ones; rank is position, so the order is the whole content.
        self.ranks = {
            (tuple(m.split(" ", 1)) if isinstance(m, str) else tuple(m)): i
            for i, m in enumerate(merges)
        }
        self.byte_encoder = _byte_encoder()
        self.sot = self.vocab["<|startoftext|>"]
        self.eot = self.vocab["<|endoftext|>"]
        self.context_len = context_len
        self._cache: dict[str, list[str]] = {}

    def _bpe(self, token: str) -> list[str]:
        """Merge a single pre-token down to the longest pieces the vocab has."""
        cached = self._cache.get(token)
        if cached is not None:
            return cached
        # the end-of-word marker rides on the last character, which is what
        # keeps "dog" and the "dog" inside "dogma" from sharing a symbol
        word = tuple(token[:-1]) + (token[-1] + "</w>",)
        pairs = _pairs(word)
        while pairs:
            bigram = min(pairs, key=lambda p: self.ranks.get(p, len(self.ranks)))
            if bigram not in self.ranks:
                break
            first, second = bigram
            merged: list[str] = []
            i = 0
            while i < len(word):
                try:
                    j = word.index(first, i)
                except ValueError:
                    merged.extend(word[i:])
                    break
                merged.extend(word[i:j])
                i = j
                if i < len(word) - 1 and word[i + 1] == second:
                    merged.append(first + second)
                    i += 2
                else:
                    merged.append(word[i])
                    i += 1
            word = tuple(merged)
            if len(word) == 1:
                break
            pairs = _pairs(word)
        out = list(word)
        self._cache[token] = out
        return out

    def encode(self, text: str) -> list[int]:
        """-> exactly `context_len` ids, SOT … EOT, zero-padded."""
        text = unicodedata.normalize("NFC", text)
        text = re.sub(r"\s+", " ", text).strip().lower()
        ids = [self.sot]
        for token in self._PAT.findall(text):
            encoded = "".join(self.byte_encoder[b] for b in token.encode("utf-8"))
            for piece in self._bpe(encoded):
                got = self.vocab.get(piece)
                if got is not None:
                    ids.append(got)
        ids.append(self.eot)
        if len(ids) > self.context_len:
            # The text tower reads the sentence off the end-of-text position,
            # so a truncated query must still end in one or it pools garbage.
            ids = ids[: self.context_len]
            ids[-1] = self.eot
        return ids + [0] * (self.context_len - len(ids))
