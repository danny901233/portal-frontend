from __future__ import annotations

import os

from core.llm_experts import SERVICE_EXPERT_CONFIDENCE_THRESHOLD, run_service_expert
from core.state import Step
from core.utils import match_service, match_service_with_scores, suggest_service_from_context
from specialists.base import SpecialistBase
from specialists.diagnostic_questions import get_relevant_questions, format_question_for_voice

# Ambiguity detection thresholds
AMBIGUITY_SCORE_THRESHOLD = 0.55
AMBIGUITY_RUNNERUP_GAP = 0.08

# Symptom keywords that suggest diagnostic service
SYMPTOM_KEYWORDS = [
    "noise", "rattle", "knocking", "vibration", "funny", "strange",
    "warning light", "dashboard light", "engine light", "check engine",
    "squeaking", "grinding", "clunking", "smell", "smoke"
]


class ServiceSpecialist(SpecialistBase):
    async def select_service(self, *, service_name: str) -> str:
        # Check if we're in diagnostic mode and need to handle an answer
        if self.state.diagnostic_mode and self.state.diagnostic_question_index > 0:
            return await self._handle_diagnostic_answer(service_name)
        
        if self.state.step != Step.NEED_SERVICE:
            if self.state.step == Step.GREETING:
                return "BLOCKED: save_caller_name must be called before select_service."
            return self.json_directive(
                status="error",
                step=self.state.step.value,
                say="Service selection isn't needed right now.",
                notes="select_service called outside NEED_SERVICE",
            )

        if not self.state.services_available and self.state.session_id:
            try:
                self.state.services_available = await self.gh.list_services(self.state.session_id)
            except Exception as exc:
                self.logger.error("[ServiceSpecialist] Failed to fetch services: %s", exc)
                self.state.reset_for_message_mode()
                return self.json_directive(
                    status="escalate",
                    step=self.state.step.value,
                    say="I'm having trouble loading the service list. Let me take your details for a callback.",
                    notes="Service fetch failed",
                )

        services = self.state.services_available
        if not services:
            self.state.reset_for_message_mode()
            return self.json_directive(
                status="escalate",
                step=self.state.step.value,
                say="I can't see any services for that vehicle. I'll grab your details for the team.",
                notes="No services available",
            )

        # Try fuzzy matching first
        best_match, best_score, second_best, second_score = match_service_with_scores(service_name, services)

        # Get full caller context from recent transcripts for better matching
        from core.utils import recent_transcript_blob
        caller_context = recent_transcript_blob(self.state.recent_transcripts, limit=4)
        if not caller_context:
            caller_context = service_name

        # Detect ambiguity
        is_ambiguous = False
        ambiguity_reason = ""

        if not best_match:
            is_ambiguous = True
            ambiguity_reason = "no match found"
        elif best_score < AMBIGUITY_SCORE_THRESHOLD:
            is_ambiguous = True
            ambiguity_reason = f"low score {best_score:.2f}"
        elif second_best and (best_score - second_score) < AMBIGUITY_RUNNERUP_GAP:
            is_ambiguous = True
            ambiguity_reason = f"close runner-up (gap {best_score - second_score:.2f})"
        else:
            # Check if caller text contains symptom keywords but match isn't diagnostic-related
            caller_lower = caller_context.lower()
            has_symptom = any(kw in caller_lower for kw in SYMPTOM_KEYWORDS)
            match_name_lower = best_match.get("name", "").lower() if best_match else ""
            is_diagnostic = "diagnostic" in match_name_lower or "inspection" in match_name_lower
            if has_symptom and not is_diagnostic:
                is_ambiguous = True
                ambiguity_reason = "symptom-based language but match not diagnostic"

        # If ambiguous, try Service Expert
        if is_ambiguous:
            self.logger.info(
                "[ServiceSpecialist] Ambiguity detected (%s); calling Service Expert",
                ambiguity_reason,
            )
            try:
                # Pass full caller context to expert, not just service_name
                expert_result = await run_service_expert(caller_context, services)
                confidence = expert_result.get("confidence", 0.0)
                clarifying_q = expert_result.get("clarifying_question", "").strip()

                if confidence >= SERVICE_EXPERT_CONFIDENCE_THRESHOLD and expert_result.get("service_price_id"):
                    # Expert picked a service
                    expert_id = str(expert_result["service_price_id"])
                    expert_name = expert_result.get("service_name", "")
                    expert_reason = expert_result.get("reason", "")
                    self.logger.info(
                        "[ServiceSpecialist] Expert selected: %s (confidence %.2f)",
                        expert_name,
                        confidence,
                    )
                    # Use expert's choice
                    best_match = next((s for s in services if str(s.get("service_price_id")) == expert_id), None)
                    if best_match:
                        service_price_id = expert_id
                        self.state.service_selected_id = service_price_id
                        self.state.service_selected_name = expert_name or best_match.get("name", service_name)
                        self.state.service_price = str(best_match.get("price", ""))
                    else:
                        # Fallback if expert returned invalid ID
                        self.logger.warning("[ServiceSpecialist] Expert returned invalid service_price_id: %s", expert_id)
                        is_ambiguous = True
                elif clarifying_q:
                    # Expert needs clarification
                    self.logger.info("[ServiceSpecialist] Expert requests clarification: %s", clarifying_q)
                    
                    # Check if expert is requesting diagnostic intake
                    if clarifying_q == "DIAGNOSTIC_INTAKE":
                        # Start diagnostic questionnaire
                        self.state.diagnostic_mode = True
                        self.state.diagnostic_question_index = 1  # Start at question 1
                        
                        # Get relevant questions based on caller's symptoms
                        questions = get_relevant_questions(caller_context, max_questions=5)
                        if not questions:
                            # Fallback if no relevant questions found
                            self.logger.warning("[ServiceSpecialist] No diagnostic questions found for context")
                            is_ambiguous = True
                        else:
                            # Store questions in state for the session
                            self.state.diagnostic_data["questions"] = [q.key for q in questions]
                            self.state.diagnostic_data["symptom_description"] = caller_context
                            self.state.diagnostic_question_index = 1  # Start at 1 since we're asking first question
                            
                            # Ask first question
                            first_question = questions[0]
                            question_text = format_question_for_voice(first_question)
                            
                            self.logger.info("[ServiceSpecialist] Starting diagnostic intake: %s", first_question.key)
                            return self.json_directive(
                                status="diagnostic_intake",
                                step=Step.NEED_SERVICE.value,
                                say=f"Right, let me get some details to help the team. {question_text}",
                                notes=f"Diagnostic Q1/{len(questions)}: {first_question.key}",
                            )
                    else:
                        # Normal clarifying question
                        return self.json_directive(
                            status="needs_input",
                            step=Step.NEED_SERVICE.value,
                            say=clarifying_q,
                            notes=f"Expert clarification (confidence {confidence:.2f})",
                        )
                else:
                    # Expert couldn't help
                    self.logger.info("[ServiceSpecialist] Expert couldn't resolve ambiguity (confidence %.2f)", confidence)
                    is_ambiguous = True
            except Exception as exc:
                self.logger.warning("[ServiceSpecialist] Service Expert failed: %s; falling back", exc)
                is_ambiguous = True

        # If still ambiguous after expert, try context rules
        if is_ambiguous or not best_match:
            # Use full caller context for better context rule matching
            suggestion = suggest_service_from_context(caller_context, services)
            if suggestion:
                svc, reason = suggestion
                say_line = f"I'd suggest a {svc.get('name')} — shall I book that in?"
                notes = f"Reason: {reason}" if reason else "Context-based suggestion"
                return self.json_directive(
                    status="needs_input",
                    step=Step.NEED_SERVICE.value,
                    say=say_line,
                    notes=notes,
                )
            options = ", ".join(s.get("name", "?") for s in services[:5])
            return self.json_directive(
                status="needs_input",
                step=Step.NEED_SERVICE.value,
                say=f"I can do {options}. What work did you need?",
                notes="Service name not matched",
            )

        # We have a match (either from fuzzy or expert)
        service_price_id = str(best_match.get("service_price_id", ""))
        self.state.service_selected_id = service_price_id
        self.state.service_selected_name = best_match.get("name", service_name)
        self.state.service_price = str(best_match.get("price", ""))

        try:
            await self.gh.set_service(self.state.session_id, service_price_id)
        except Exception as exc:
            self.logger.error("[ServiceSpecialist] set_service failed: %s", exc)
            return self.json_directive(
                status="error",
                step=self.state.step.value,
                say="Something went wrong setting that. Could we try again?",
                notes="set_service API error",
            )

        try:
            self.state.timeslots_available = await self.gh.list_timeslots(self.state.session_id)
        except Exception as exc:
            self.logger.warning("[ServiceSpecialist] timeslot prefetch failed: %s", exc)
            self.state.timeslots_available = []

        self.state.step = Step.NEED_TIMESLOT
        say_line = "When suits you? Earliest I've got is {slot1} or {slot2}."
        if self.state.timeslots_available:
            preview = self.state.timeslots_available[:2]
            human = [f"{slot['date']} at {slot['time']}" for slot in preview]
            say_line = f"When suits you? I've got {', '.join(human)}."

        notes = f"Service set: {self.state.service_selected_name} (£{self.state.service_price or 'n/a'})"
        return self.json_directive(
            status="ok",
            step=Step.NEED_TIMESLOT.value,
            say=say_line,
            notes=notes,
        )

    async def _handle_diagnostic_answer(self, answer: str) -> str:
        """Handle caller's answer to a diagnostic question and progress through questionnaire."""
        from specialists.diagnostic_questions import DIAGNOSTIC_QUESTIONS
        
        question_keys = self.state.diagnostic_data.get("questions", [])
        current_index = self.state.diagnostic_question_index - 1  # Convert to 0-based
        
        if current_index >= len(question_keys):
            self.logger.error("[ServiceSpecialist] Diagnostic index out of range")
            self.state.diagnostic_mode = False
            return "I've got all the details I need. Let me book that diagnostic in for you."
        
        # Store the answer
        current_key = question_keys[current_index]
        self.state.diagnostic_data[current_key] = answer
        self.logger.info("[ServiceSpecialist] Diagnostic answer recorded: %s = %s", current_key, answer[:50])
        
        # Check if more questions remain
        if self.state.diagnostic_question_index < len(question_keys):
            # Ask next question
            next_key = question_keys[self.state.diagnostic_question_index]
            next_question = next((q for q in DIAGNOSTIC_QUESTIONS if q.key == next_key), None)
            
            if not next_question:
                self.logger.warning("[ServiceSpecialist] Question key not found: %s", next_key)
                self.state.diagnostic_mode = False
                return "Right, I've got the details. Let me get that booked in."
            
            question_text = format_question_for_voice(next_question)
            self.state.diagnostic_question_index += 1
            
            return self.json_directive(
                status="diagnostic_intake",
                step=Step.NEED_SERVICE.value,
                say=question_text,
                notes=f"Diagnostic Q{self.state.diagnostic_question_index}/{len(question_keys)}: {next_key}",
            )
        else:
            # All questions answered - compile notes and suggest Diagnostics
            self.logger.info("[ServiceSpecialist] Diagnostic intake complete")
            self.state.diagnostic_mode = False
            
            # Build diagnostic notes
            notes_parts = [f"Symptom: {self.state.diagnostic_data.get('symptom_description', 'Unknown')}"]
            for key in question_keys:
                answer = self.state.diagnostic_data.get(key, "Not answered")
                notes_parts.append(f"{key}: {answer}")
            self.state.notes = " | ".join(notes_parts)
            
            # Try to select Diagnostics service
            services = self.state.services_available
            diagnostics = next((s for s in services if "diagnostic" in s.get("name", "").lower()), None)
            
            if diagnostics:
                service_price_id = str(diagnostics.get("service_price_id", ""))
                self.state.service_selected_id = service_price_id
                self.state.service_selected_name = diagnostics.get("name", "Diagnostics")
                self.state.service_price = str(diagnostics.get("price", ""))
                
                try:
                    await self.gh.set_service(self.state.session_id, service_price_id)
                except Exception as exc:
                    self.logger.error("[ServiceSpecialist] set_service failed after diagnostic: %s", exc)
                    return "I've got all the details. Let me take your contact info and the team will ring you back."
                
                try:
                    self.state.timeslots_available = await self.gh.list_timeslots(self.state.session_id)
                except Exception as exc:
                    self.logger.warning("[ServiceSpecialist] timeslot prefetch failed: %s", exc)
                    self.state.timeslots_available = []
                
                self.state.step = Step.NEED_TIMESLOT
                if self.state.timeslots_available:
                    preview = self.state.timeslots_available[:2]
                    human = [f"{slot['date']} at {slot['time']}" for slot in preview]
                    say_line = f"Right, I've got all that. When suits you for the diagnostic? I've got {', '.join(human)}."
                else:
                    say_line = "Right, I've got all that. When would suit you for the diagnostic?"
                
                return self.json_directive(
                    status="ok",
                    step=Step.NEED_TIMESLOT.value,
                    say=say_line,
                    notes=f"Diagnostics after intake: {self.state.service_selected_name}",
                )
            else:
                # No diagnostics service available - take message
                self.logger.warning("[ServiceSpecialist] No diagnostics service found after intake")
                self.state.reset_for_message_mode()
                return self.json_directive(
                    status="escalate",
                    step=self.state.step.value,
                    say="I've got all those details. Let me take your number and the team will give you a ring.",
                    notes="No diagnostics service available",
                )
