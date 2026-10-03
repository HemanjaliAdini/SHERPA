"""Build Cypher text for TuringDB, which has no query parameters."""


def lit(v) -> str:
    """Cypher literal; TuringDB has no query parameters."""
    if isinstance(v, bool):
        return "true" if v else "false"
    if isinstance(v, str):
        return "'" + v.replace("\\", "\\\\").replace("'", "\\'") + "'"
    if isinstance(v, list):
        return "[" + ", ".join(lit(x) for x in v) + "]"
    return repr(v)


def props(**kw) -> str:
    return "{" + ", ".join(f"{k}: {v}" for k, v in kw.items()) + "}"
