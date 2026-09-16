"""Editable LLM prompts used by the local SpotterDex manager.

Keep prompt wording here so caption-generation behaviour can be tuned without
editing the manager's file and without changing image preparation or API code.
"""

CAPTION_SYSTEM_PROMPT = (
    "You are a precise aviation photography caption editor. "
    "Use the image and every supplied metadata field to write a useful, factual caption. "
    "Never invent aircraft, markings, actions, surroundings, or locations, and never contradict "
    "what the image visibly shows."
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
    """Build the user prompt for a new caption or an existing-caption refinement."""
    mode = "refine an existing caption" if draft_caption.strip() else "generate a new caption"
    return "\n".join(
        [
            f"Task: {mode} for this aviation photograph.",
            "Return one concise, polished English caption.",
            "Use the image for visible facts and use every supplied metadata field for context. "
            "Metadata can identify the aircraft, operator, country, location, event, and livery even when "
            "those facts cannot be proven from the pixels alone; omit metadata only when it is missing or "
            "clearly conflicts with the image.",
            "",
            "First, study the image:",
            "- Describe the aircraft type supplied in the metadata, adding a visible variant or configuration "
            "only when it is supported by the image.",
            "- Read any legible markings: serials, registrations, codes, roundels, tail art, or unit badges.",
            "- Describe what the aircraft is doing from concrete cues such as landing gear up or down, extended flaps "
            "or airbrakes, wheel smoke on touchdown, afterburner glow or exhaust haze, vapour or smoke trails, "
            "bank angle, formation position, fly-by, low pass, landing, taxiing, or take-off.",
            "- Describe the surroundings and environment that are visible: runway, taxiway, ramp, sky, terrain, "
            "buildings, weather, season, or lighting. Name the supplied location and event when available.",
            "",
            "Use the metadata deliberately:",
            "- Include the country, aircraft type, squadron or organisation, location, event, and livery when "
            "they are supplied and compatible with the image.",
            "- Treat a supplied location or event as useful catalog context; do not drop it merely because the "
            "background does not identify it.",
            "- If the image contradicts a metadata field, describe only the supported fact and avoid the conflict.",
            "",
            "Caption structure (a guide, not a rigid template):",
            "[country] [aircraft type] ([livery, if present]) from [squadron/organisation] [what it is doing] "
            "in the [surroundings/environment] at [location] during [event].",
            "Vary the wording naturally while keeping the aircraft type, action, environment, and useful metadata "
            "clear and concise.",
            "Omit only missing or conflicting details; never write placeholders or explanations.",
            "",
            "For refinement mode, rewrite the existing caption as a complete replacement. Preserve its accurate "
            "registrations, callsigns, variants, flight details, and other useful identifiers, while correcting "
            "unsupported claims and adding relevant supplied metadata or visible environment details.",
            "For new-caption mode, create the caption from the image and supplied metadata without referring to a "
            "missing draft.",
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
