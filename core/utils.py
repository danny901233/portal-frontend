from __future__ import annotations

import re
from datetime import datetime
from difflib import SequenceMatcher
from pathlib import Path
from typing import Dict, Iterable, List, Optional, Sequence

from zoneinfo import ZoneInfo

_NATO_LETTER_MAP = {
    "alpha": "A",
    "bravo": "B",
    "charlie": "C",
    "delta": "D",
    "echo": "E",
    "foxtrot": "F",
    "golf": "G",
    "hotel": "H",
    "india": "I",
    "juliet": "J",
    "juliett": "J",
    "kilo": "K",
    "lima": "L",
    "mike": "M",
    "november": "N",
    "oscar": "O",
    "papa": "P",
    "quebec": "Q",
    "romeo": "R",
    "sierra": "S",
    "tango": "T",
    "uniform": "U",
    "victor": "V",
    "whiskey": "W",
    "whisky": "W",
    "xray": "X",
    "x-ray": "X",
    "yankee": "Y",
    "zulu": "Z",
}

_LETTER_PRONUNCIATIONS = {
    "ay": "A",
    "bee": "B",
    "be": "B",
    "cee": "C",
    "see": "C",
    "dee": "D",
    "ee": "E",
    "ef": "F",
    "eff": "F",
    "gee": "G",
    "aitch": "H",
    "itch": "H",
    "eye": "I",
    "jay": "J",
    "kay": "K",
    "el": "L",
    "ell": "L",
    "em": "M",
    "en": "N",
    "pee": "P",
    "pea": "P",
    "cue": "Q",
    "queue": "Q",
    "are": "R",
    "ar": "R",
    "ess": "S",
    "es": "S",
    "tee": "T",
    "tea": "T",
    "you": "U",
    "yew": "U",
    "vee": "V",
    "doubleyou": "W",
    "double-you": "W",
    "doubleu": "W",
    "ex": "X",
    "eks": "X",
    "why": "Y",
    "wy": "Y",
    "zed": "Z",
    "zee": "Z",
}

_NATO_LETTER_MAP.update(_LETTER_PRONUNCIATIONS)

_DIGIT_WORD_MAP = {
    "zero": "0",
    "oh": "0",
    "owe": "0",
    "o": "0",
    "naught": "0",
    "nought": "0",
    "one": "1",
    "won": "1",
    "two": "2",
    "too": "2",
    "to": "2",
    "three": "3",
    "tree": "3",
    "four": "4",
    "for": "4",
    "five": "5",
    "fife": "5",
    "six": "6",
    "seven": "7",
    "eight": "8",
    "ate": "8",
    "nine": "9",
    "niner": "9",
}

_ALL_NATO_DIGIT_WORDS: Dict[str, str] = {**_NATO_LETTER_MAP, **_DIGIT_WORD_MAP}
_SORTED_NATO_DIGIT_WORDS = sorted(
    ((word, char) for word, char in _ALL_NATO_DIGIT_WORDS.items() if len(word) >= 2),
    key=lambda pair: len(pair[0]),
    reverse=True,
)

_SERVICE_CONTEXT_RULES: List[tuple[List[str], str, str]] = [
    (
        [
            "long time",
            "ages",
            "while",
            "overdue",
            "hasn't been",
            "haven't had",
            "not been serviced",
            "not had it serviced",
            "due a service",
            "needs a service",
            "general service",
            "general check",
        ],
        "full service",
        "it sounds like it's due a full service",
    ),
    (["mot", "m.o.t", "m o t", "test", "annual test"], "mot", ""),
    (["brakes", "brake", "squeaking", "grinding", "stopping"], "brake", "that sounds like it could be a brake issue"),
    (["oil", "oil change", "oil top up"], "oil", "an oil change should sort that"),
    (["tyres", "tires", "tire", "tyre", "flat", "puncture", "tracking"], "tyre", ""),
    (["noise", "rattle", "knocking", "vibration", "funny sound", "strange sound", "clunking"], "diagnostic", "a diagnostic check would be the best place to start"),
    (["warning light", "dashboard light", "engine light", "check engine"], "diagnostic", "a diagnostic check will find out what's going on"),
    (["air con", "aircon", "a/c", "ac", "air conditioning", "cold air", "heating"], "air con", ""),
    (["cam belt", "cambelt", "timing belt", "timing chain"], "cam belt", ""),
]


def uk_now() -> datetime:
    return datetime.now(ZoneInfo("Europe/London"))


def load_env_files(candidates: Sequence[Path]) -> List[Path]:
    loaded: List[Path] = []
    for path in candidates:
        if path.exists():
            from dotenv import load_dotenv  # type: ignore

            load_dotenv(path, override=True)
            loaded.append(path)
    return loaded


def resolve_env_value(raw_value: str | None, default: str, placeholders: set[str]) -> str:
    cleaned = (raw_value or "").strip()
    if not cleaned or cleaned.lower() in placeholders:
        return default
    return cleaned


def dynamic_greeting(branch_name: str, canned_line: str | None = None) -> str:
    now = uk_now()
    period = "morning"
    hour = now.hour
    if 12 <= hour < 17:
        period = "afternoon"
    elif 17 <= hour < 24:
        period = "evening"

    if canned_line:
        return re.sub(r"timeofday", f"good {period}", canned_line, flags=re.IGNORECASE)
    return f"Hello, you're through to {branch_name}. How can I help?"


def normalize_vehicle_registration(reg: str) -> str:
    if not reg:
        return ""
    tokens = re.split(r"[\s,;:/\\-_]+", reg.strip())
    converted: List[str] = []
    for token in tokens:
        if not token:
            continue
        cleaned = re.sub(r"[^A-Za-z0-9]", "", token)
        if not cleaned:
            continue
        lower = cleaned.lower()
        if lower in _NATO_LETTER_MAP:
            converted.append(_NATO_LETTER_MAP[lower])
            continue
        if lower in _DIGIT_WORD_MAP:
            converted.append(_DIGIT_WORD_MAP[lower])
            continue
        if len(cleaned) == 1:
            converted.append(cleaned.upper())
            continue
        converted.extend(_scan_nato_blob(cleaned))
    if converted:
        return "".join(converted)
    return "".join(char.upper() for char in reg if char.isalnum())


def _scan_nato_blob(text: str) -> List[str]:
    result: List[str] = []
    lower = text.lower()
    i = 0
    while i < len(lower):
        if not lower[i].isalnum():
            i += 1
            continue
        matched = False
        for word, char in _SORTED_NATO_DIGIT_WORDS:
            end = i + len(word)
            if end <= len(lower) and lower[i:end] == word:
                result.append(char)
                i = end
                matched = True
                break
        if not matched:
            ch = lower[i]
            if ch == "o":
                result.append("0")
            else:
                result.append(ch.upper())
            i += 1
    return result


def suggest_service_from_context(caller_text: str, services: List[dict]) -> Optional[tuple[dict, str]]:
    text = caller_text.lower()
    for keywords, svc_substr, reason in _SERVICE_CONTEXT_RULES:
        if any(keyword in text for keyword in keywords):
            for svc in services:
                if svc_substr in svc.get("name", "").lower():
                    return svc, reason
    return None


def match_service(name_hint: str, services: List[dict]) -> Optional[dict]:
    if not services or not name_hint:
        return None
    target = _normalize_service_text(name_hint)
    if not target:
        return None

    best_match: Optional[dict] = None
    best_score = 0.0
    for service in services:
        svc_name = _normalize_service_text(service.get("name", ""))
        if not svc_name:
            continue
        if svc_name == target:
            return service
        score = SequenceMatcher(None, target, svc_name).ratio()
        if target in svc_name or svc_name in target:
            score += 0.25
        if score > best_score:
            best_score = score
            best_match = service
    return best_match if best_score >= 0.45 else None


def match_service_with_scores(name_hint: str, services: List[dict]) -> tuple[Optional[dict], float, Optional[dict], float]:
    """
    Enhanced match_service that returns:
        (best_match, best_score, second_best_match, second_best_score)
    Used for ambiguity detection.
    """
    if not services or not name_hint:
        return None, 0.0, None, 0.0
    target = _normalize_service_text(name_hint)
    if not target:
        return None, 0.0, None, 0.0

    scored_services: List[tuple[dict, float]] = []
    for service in services:
        svc_name = _normalize_service_text(service.get("name", ""))
        if not svc_name:
            continue
        if svc_name == target:
            return service, 1.0, None, 0.0
        score = SequenceMatcher(None, target, svc_name).ratio()
        if target in svc_name or svc_name in target:
            score += 0.25
        scored_services.append((service, score))

    if not scored_services:
        return None, 0.0, None, 0.0

    scored_services.sort(key=lambda x: x[1], reverse=True)
    best_match, best_score = scored_services[0]
    second_best, second_score = (scored_services[1] if len(scored_services) > 1 else (None, 0.0))

    if best_score < 0.45:
        return None, best_score, second_best, second_score
    return best_match, best_score, second_best, second_score


def _normalize_service_text(value: str) -> str:
    return re.sub(r"[^a-z0-9]+", " ", value.lower()).strip()


def recent_transcript_blob(transcripts: Iterable[str], limit: int = 4) -> str:
    snippet = list(transcripts)[-limit:]
    return " ".join(snippet).strip()
