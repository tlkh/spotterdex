"""Editable LLM prompts used by the local SpotterDex manager.

Keep prompt wording here so caption-generation behaviour can be tuned without
editing the manager's file and without changing image preparation or API code.
"""

CAPTION_SYSTEM_PROMPT = "You are a precise aviation photography caption editor."


def build_caption_prompt(
    *,
    aircraft_type: str,
    squadron_name: str,
    location: str,
    airshow: str,
    livery: str,
    draft_caption: str,
) -> str:
    """Build the user prompt for new captions and caption refinement."""
    return "\n".join(
        [
            "Write one concise, polished English caption for this aviation photograph.",
            "Use the image and the supplied metadata. Return only the final caption, without a label, "
            "quotation marks, Markdown, or an explanation.",
            "The caption must be accurate and specific, but do not invent a registration, date, weather, "
            "mission, livery detail, manoeuvre, or other fact that is not visibly supported or supplied.",
            "If an existing caption is supplied, refine it when useful and remove unsupported details.",
            "",
            f"Aircraft type: {aircraft_type or 'Not supplied'}",
            f"Squadron or operator: {squadron_name or 'Not supplied'}",
            f"Location: {location or 'Not supplied'}",
            f"Airshow event: {airshow or 'Not supplied'}",
            f"Livery or paint scheme: {livery or 'Not supplied'}",
            f"Existing caption: {draft_caption or 'None'}",
        ]
    )
