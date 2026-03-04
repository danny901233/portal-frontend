# LiveKit Agent Behavioral Tests

This folder contains text-only evaluations for the ReceptionMate LiveKit agent using the official [Testing & Evaluation guide](https://docs.livekit.io/agents/start/testing/).

## Prerequisites

1. **Python environment** – use `uv` (preferred) or any Python 3.11+ interpreter.
2. **Dependencies** – install once:
   ```bash
   uv pip install -r agent-tests/requirements.txt
   ```
3. **LLM access** – set `OPENAI_API_KEY` so the LiveKit testing helpers can judge the agent's responses. Override `LIVEKIT_TEST_MODEL` if you want a different OpenAI model (defaults to `gpt-4o-mini`).
4. **Agent module path** – point `RECEPTION_AGENT_MODULE` at your `multi_agent_receptionmatenew.py`. For example:
   ```bash
   export RECEPTION_AGENT_MODULE=$HOME/Downloads/multi_agent_receptionmatenew.py
   ```

## Running the tests

Execute the Vitest-style behavioral check with pytest:

```bash
uv run pytest agent-tests/test_reception_agent.py -s
```

The test spins up a text-only `AgentSession`, runs the greeting workflow, and asserts that:
- The caller's name is persisted via the correct tool.
- Quote requests are routed to `InitBookingAgent` with `intent="quote"`.
- The agent performs a handoff with no extra speech between tools.

If you do not want to hit the real LLM during local development, set `PYTEST_ADDOPTS="-k offline"` and skip the test, or mock `session.run` in your own fixtures.
