import { redirect } from 'next/navigation';

export default function AgentSetupIndex() {
  redirect('/agent-setup/identity');
}
