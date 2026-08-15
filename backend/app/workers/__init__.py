def pool_init(thumb_max_dim: int, thumb_quality: int) -> None:
    """ProcessPool initializer shared by photo and video workers."""
    from . import image_worker, video_worker

    image_worker.pool_init(thumb_max_dim, thumb_quality)
    video_worker.pool_init(thumb_max_dim, thumb_quality)
