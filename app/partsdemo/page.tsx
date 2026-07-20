// Public, auth-bypassed /partsdemo — the trade-parts-counter voice demo (for the parts pitch).
// Same shared UI as /demo, but talks to the demo agent's "parts" persona: give a reg + a part,
// it quotes a few brand options, upsells the related line and "books" it onto the van. Calls are
// recorded and logged to the ReceptionMate Demo branch, exactly like /demo.
import VoiceDemo from '../components/VoiceDemo';

export default function PartsDemoPage() {
  return <VoiceDemo scenario="parts" />;
}
