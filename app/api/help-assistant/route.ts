import { NextResponse } from 'next/server';

const SUPPORT_EMAIL = 'hello@receptionmate.co.uk';

const PORTAL_KNOWLEDGE_SNIPPET = `You are the ReceptionMate Portal help assistant. Speak like a friendly human support specialist.

Key features:
- Calls page: filter by tag, date, duration; supports Boolean queries with AND/OR/NOT and quoted phrases; call detail pages show transcripts, recordings, and feedback.
- Feedback workflow: thumbs up/down, capture reasons and notes, syncs instantly.
- Agent configuration: manage branch details, tone, opening hours, knowledge base scanning and publication.
- Knowledge base: discover website pages, select which to ingest, repeat after updates.
- Dashboard: high-level metrics for call volume and feedback trends.
- Troubleshooting: refresh, clear filters, re-run scans; escalate with call IDs/timestamps if still blocked.

Always encourage users to share the 8-digit Call ID and relevant timestamps when asking for help. If you cannot answer or sense escalation is needed, direct them to email ${SUPPORT_EMAIL}.

When helpful, reference sections of /help using anchors (e.g., "/help#advanced-search") and keep answers concise but warm.`;

type IncomingMessage = {
  role: 'user' | 'assistant';
  content: string;
};

type RequestBody = {
  messages?: IncomingMessage[];
};

const OPENAI_ENDPOINT = 'https://api.openai.com/v1/chat/completions';

async function callOpenAI(messages: IncomingMessage[]) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error('Missing OPENAI_API_KEY environment variable.');
  }

  const payload = {
    model: 'gpt-3.5-turbo',
    temperature: 0.6,
    max_tokens: 400,
    messages: [
      {
        role: 'system' as const,
        content: PORTAL_KNOWLEDGE_SNIPPET,
      },
      ...messages.map((message) => ({
        role: message.role,
        content: message.content,
      })),
    ],
  };

  const response = await fetch(OPENAI_ENDPOINT, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(payload),
  });

  const rawBody = await response.text();

  if (!response.ok) {
    throw new Error(`OpenAI request failed: ${response.status} ${response.statusText} - ${rawBody}`);
  }

  const data: {
    choices?: Array<{
      message?: { role?: string; content?: string };
    }>;
  } = rawBody ? JSON.parse(rawBody) : {};

  const choice = data.choices?.[0]?.message?.content;
  if (!choice) {
    throw new Error('OpenAI returned an empty response.');
  }
  return choice.trim();
}

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as RequestBody;
    if (!body.messages || !Array.isArray(body.messages) || body.messages.length === 0) {
      return NextResponse.json({ error: 'Messages array is required.' }, { status: 400 });
    }

    const sanitizedMessages: IncomingMessage[] = body.messages
      .slice(-12)
      .map((message) => ({
        role: (message.role === 'assistant' ? 'assistant' : 'user') as 'user' | 'assistant',
        content: String(message.content).slice(0, 2000),
      }));

    const reply = await callOpenAI(sanitizedMessages);

    return NextResponse.json({ reply });
  } catch (error) {
    console.error('Help assistant error:', error);
    return NextResponse.json(
      {
        error:
          'I ran into an issue answering that. Please try again in a moment, or email hello@receptionmate.co.uk with your question and any call IDs.',
      },
      { status: 500 },
    );
  }
}
