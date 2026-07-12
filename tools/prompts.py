"""Editable LLM prompts used by the local SpotterDex manager.

Keep prompt wording here so caption-generation behaviour can be tuned without
editing the manager's file and without changing image preparation or API code.
"""

CAPTION_SYSTEM_PROMPT = (
    "You are a precise aviation photography caption editor. "
    "You caption only what the image visibly shows and what the supplied metadata confirms, "
    "and you never invent aircraft, markings, actions, or locations."
)


def build_caption_prompt(
    *,
    country: str,
    aircraft_type: str,
    squadron_name: str,
    unit_type: str,
    location: str,
    airshow: str,
    livery: str,
    draft_caption: str,
) -> str:
    """Build the user prompt for new captions and caption refinement."""
    return "\n".join(
        [
            "Write one concise, polished English caption for this aviation photograph.",
            "The image is the primary source of truth. The metadata below only supplements what you can see; "
            "it may be incomplete or mistaken.",
            "",
            "First, study the image:",
            "- Confirm the aircraft matches the supplied type, and note the viewing angle and framing "
            "(head-on, banking, topside, underside, on the ground).",
            "- Read any legible markings: serials, registrations, codes, roundels, tail art, or unit badges.",
            "- Determine the visible action from concrete cues such as landing gear up or down, extended flaps "
            "or airbrakes, wheel smoke on touchdown, afterburner glow or exhaust haze, vapour or smoke trails, "
            "bank angle, or formation position.",
            "- Note the setting only when it is clearly shown: runway, taxiway, ramp, sky, or terrain, plus any "
            "obvious weather or lighting.",
            "",
            "Then reconcile the image with the metadata:",
            "- When the image and metadata agree, state the fact confidently.",
            "- Use metadata you cannot verify visually (such as operator, location, or event) make sure it is "
            "plausibly consistent with the image, else do not include it.",
            "",
            "Caption structure (a guide, not a rigid template):",
            "[country] [aircraft type] ([livery, if present]) from [squadron/organisation] [visible action] "
            "at [location] during [event].",
            "Vary the wording naturally when useful, but retain the same useful facts and keep the result clear "
            "and concise.",
            "Omit any part you cannot support rather than writing placeholders or inventing details.",
            "Base the visible action on something shown in the image or supplied in the metadata, for example a "
            "fly-by, low pass, landing, taxiing, or taking off. Do not invent an action or any other fact that is "
            "not visibly supported or supplied.",
            "",
            "If an existing caption is supplied, retain as much accurate additional information as possible, "
            "including registrations, callsigns, variants, flight details, or other useful identifiers. "
            "Do not include details that conflict with the image or supplied metadata.",
            "",
            "Return only the final caption as a single line of plain text, without a label, quotation marks, "
            "Markdown, or any explanation.",
            "",
            f"Country: {country or 'Not supplied'}",
            f"Aircraft type: {aircraft_type or 'Not supplied'}",
            f"Squadron or operator: {squadron_name or 'Not supplied'}",
            f"Unit type: {unit_type or 'Not supplied'}",
            f"Location: {location or 'Not supplied'}",
            f"Airshow event: {airshow or 'Not supplied'}",
            f"Livery or paint scheme: {livery or 'Not supplied'}",
            f"Existing caption: {draft_caption or 'None'}",
        ]
    )
