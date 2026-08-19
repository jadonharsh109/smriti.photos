import { IconClose, IconSearch } from "./Icons";

interface Props {
  value: string;
  onChange: (value: string) => void;
  placeholder: string;
  /** e.g. "3 of 42" — shown only while a query is active. */
  result?: string;
}

/** Filter-as-you-type box for a list that is already in memory.
 *
 *  People and Places both fetch their whole list in one request, so filtering
 *  happens locally and there is nothing to debounce or wait for — the results
 *  change on the keystroke. */
export default function SearchBox({ value, onChange, placeholder, result }: Props) {
  return (
    <span className="searchbox">
      <span className="mag">
        <IconSearch size={16} />
      </span>
      <input
        type="text"
        value={value}
        placeholder={placeholder}
        aria-label={placeholder}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Escape" && value) {
            e.stopPropagation();
            onChange("");
          }
        }}
      />
      {value && (
        <>
          {result && <span className="hits">{result}</span>}
          <button className="clear" title="Clear search (Esc)" onClick={() => onChange("")}>
            <IconClose size={14} />
          </button>
        </>
      )}
    </span>
  );
}
