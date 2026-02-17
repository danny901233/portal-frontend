"""Diagnostic questionnaire for gathering fault information.

Based on GarageHive diagnostic intake forms - asks relevant questions
when a caller reports symptoms/issues with their vehicle.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import List, Optional


@dataclass
class DiagnosticQuestion:
    """A single diagnostic question with possible answers."""
    key: str
    question: str
    options: List[str]
    multi_select: bool = False
    triggers: List[str] = field(default_factory=list)  # Keywords that make this question relevant


# Diagnostic questionnaire based on GarageHive fault description form
DIAGNOSTIC_QUESTIONS = [
    DiagnosticQuestion(
        key="when_first_occur",
        question="When did the fault first occur?",
        options=["Just started", "Last week", "Last month", "Other"],
        triggers=["warning light", "noise", "problem", "issue", "fault", "squeaking", "grinding", "knocking"],
    ),
    DiagnosticQuestion(
        key="starting_issues",
        question="Are there any starting issues?",
        options=[
            "No, starts and runs fine",
            "Won't crank",
            "Crank, but won't start",
            "Starts, but after a few attempts"
        ],
        triggers=["start", "starting", "crank", "turn over", "battery", "won't start"],
    ),
    DiagnosticQuestion(
        key="engine_quits_stalls",
        question="Does the engine quit or stall?",
        options=[
            "No",
            "Straight after starting",
            "When put into gear",
            "During steady speed driving",
            "When vehicle comes to stop",
            "While idling",
            "During acceleration",
            "While parking"
        ],
        triggers=["stall", "cuts out", "dies", "stops running", "shuts off"],
    ),
    DiagnosticQuestion(
        key="poor_idling",
        question="How's the idling?",
        options=[
            "None noticed",
            "Too slow at times",
            "Too fast",
            "Rough",
            "Uneven",
            "Fluctuates up and down",
            "Intermittent"
        ],
        triggers=["idle", "idling", "rough", "vibration", "shaking"],
    ),
    DiagnosticQuestion(
        key="poor_running",
        question="Is there poor running or performance issues?",
        options=[
            "None noticed",
            "Run rough",
            "Lack of power",
            "Judders",
            "Hesitates when accelerating",
            "Misfire",
            "Cuts out",
            "Engine noise",
            "Knocking noise",
            "Engine pings",
            "Surges"
        ],
        triggers=["power", "acceleration", "slow", "sluggish", "misfire", "judder", "hesitate"],
    ),
    DiagnosticQuestion(
        key="transmission_issues",
        question="Any transmission or gearbox issues?",
        options=[
            "None",
            "Improper shifting",
            "Early",
            "Late",
            "Changes gear incorrectly",
            "Vehicle doesn't move when in gear",
            "Jerks when in gear",
            "Stalls when in gear"
        ],
        triggers=["gear", "gearbox", "transmission", "shifting", "clutch"],
    ),
    DiagnosticQuestion(
        key="when_issues_occur",
        question="When do the issues occur?",
        options=[
            "From cold start",
            "When engine is warm",
            "Short journey",
            "Long journey",
            "Stop/start driving",
            "While turning",
            "While braking",
            "When changing gear",
            "When A/C is switched on",
            "When headlights are switched on",
            "When accelerating",
            "Uphill",
            "Downhill",
            "Rough road"
        ],
        multi_select=True,
        triggers=["when", "during", "while", "after"],
    ),
    DiagnosticQuestion(
        key="driving_style",
        question="What's your typical driving style?",
        options=[
            "Mostly motorway",
            "Around town",
            "Short journeys",
            "Long journeys"
        ],
        triggers=["driving", "drive", "use", "journey"],
    ),
    DiagnosticQuestion(
        key="warning_lights",
        question="Are there any warning lights on?",
        options=[
            "No warning lights",
            "Intermittent lights",
            "Lights always on",
            "Amber warning light",
            "Red warning light",
            "Yellow check engine light is always on"
        ],
        triggers=["warning light", "dashboard light", "engine light", "check engine", "light on"],
    ),
    DiagnosticQuestion(
        key="smells",
        question="Any unusual smells?",
        options=[
            "No",
            "Fuel",
            "Hot",
            "Electrical",
            "Oil burning",
            "Other"
        ],
        triggers=["smell", "smells", "burning", "smoke", "fumes"],
    ),
    DiagnosticQuestion(
        key="noises",
        question="What noises have you noticed?",
        options=[
            "None noticed",
            "Rattle",
            "Knock",
            "Squeak",
            "Other"
        ],
        triggers=["noise", "sound", "rattle", "knock", "squeak", "grinding", "clunk"],
    ),
]


def get_relevant_questions(caller_text: str, max_questions: int = 5) -> List[DiagnosticQuestion]:
    """
    Get diagnostic questions relevant to the caller's reported issue.
    
    Args:
        caller_text: The caller's description of the problem
        max_questions: Maximum number of questions to return
        
    Returns:
        List of relevant diagnostic questions, ordered by relevance
    """
    text_lower = caller_text.lower()
    
    # Score each question by trigger keyword matches
    scored_questions: List[tuple[DiagnosticQuestion, int]] = []
    for question in DIAGNOSTIC_QUESTIONS:
        matches = sum(1 for trigger in question.triggers if trigger in text_lower)
        if matches > 0:
            scored_questions.append((question, matches))
    
    # Sort by relevance (most matches first)
    scored_questions.sort(key=lambda x: x[1], reverse=True)
    
    # Always include "when_first_occur" and "warning_lights" if any symptoms mentioned
    essential_keys = {"when_first_occur", "warning_lights"}
    symptom_keywords = ["problem", "issue", "fault", "warning", "light", "noise", "smell"]
    has_symptoms = any(kw in text_lower for kw in symptom_keywords)
    
    result = []
    seen_keys = set()
    
    # Add scored questions first
    for question, _ in scored_questions:
        if question.key not in seen_keys and len(result) < max_questions:
            result.append(question)
            seen_keys.add(question.key)
    
    # Add essential questions if symptoms mentioned and not already included
    if has_symptoms:
        for question in DIAGNOSTIC_QUESTIONS:
            if question.key in essential_keys and question.key not in seen_keys and len(result) < max_questions:
                result.append(question)
                seen_keys.add(question.key)
    
    return result[:max_questions]


def format_question_for_voice(question: DiagnosticQuestion) -> str:
    """
    Format a diagnostic question for natural voice conversation.
    
    Args:
        question: The diagnostic question to format
        
    Returns:
        Natural British English phrasing of the question with options
    """
    if question.key == "when_first_occur":
        return f"{question.question} Was it just this week, last month, or longer ago?"
    elif question.key == "starting_issues":
        return "Does it start alright, or are there any starting issues?"
    elif question.key == "engine_quits_stalls":
        return "Does it cut out or stall at all?"
    elif question.key == "poor_idling":
        return "How's the idling? Does it run smoothly when stopped, or is it rough?"
    elif question.key == "poor_running":
        return "When you're driving, does it lack power or hesitate at all?"
    elif question.key == "transmission_issues":
        return "Any issues with the gears or how it shifts?"
    elif question.key == "when_issues_occur":
        return "When does the problem happen? Is it from cold, when it's warm, during short trips, or long journeys?"
    elif question.key == "driving_style":
        return "What's your typical driving like? Mostly motorway, around town, or short trips?"
    elif question.key == "warning_lights":
        return "Are there any warning lights on the dashboard?"
    elif question.key == "smells":
        return "Have you noticed any unusual smells?"
    elif question.key == "noises":
        return "What sort of noise is it? A rattle, knock, squeak, or something else?"
    else:
        # Fallback to original question
        return question.question
