// Public, auth-bypassed /demo — the "try it yourself" garage-receptionist voice demo.
// The UI lives in the shared <VoiceDemo> client component; /partsdemo renders the parts variant.
import VoiceDemo from '../components/VoiceDemo';

export default function DemoPage() {
  return <VoiceDemo scenario="booking" />;
}
