#!/usr/bin/env python3
"""Assemble the onboarding flow document. Keeps the 50KB logo data-URI out of the HTML source
so the page stays editable; it's injected at build time."""
import pathlib

here = pathlib.Path(__file__).parent
logo = (here / 'logo_datauri.txt').read_text().strip()
html = (here / 'flow.html').read_text()
out = html.replace('{{LOGO}}', logo)
(here / 'flow.built.html').write_text(out)
print(f'✓ flow.built.html ({len(out)//1024}KB)')
