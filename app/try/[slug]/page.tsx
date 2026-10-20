// The page a cold prospect lands on from the personal link in our email. Their own AI
// receptionist, answering as their garage.
//
// The URL carries their name — /try/binley-woods-service-centre-9f3a — because the link is the
// pitch: they can see it is theirs before deciding whether to click.
//
// Server component only to unwrap the dynamic segment; everything interactive is in the client
// component below it. In this version of Next `params` is a Promise and must be awaited — reading
// it synchronously is a build error, not a warning.

import TryClient from './TryClient';

export const metadata = {
  title: 'Hear your receptionist',
  // A personal cold link has no business being indexed.
  robots: { index: false, follow: false },
};

export default async function TryPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  return <TryClient slug={slug} />;
}
