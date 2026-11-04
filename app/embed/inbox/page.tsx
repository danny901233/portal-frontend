// The messages inbox with no portal chrome, for sitting inside a customer's own system in an
// iframe (first user: The Gearbox Centre's central sales team, reading all five branches). The
// page decides from its pathname what to hide and that it spans every branch; AppShell keeps the
// session but leaves the sidebar, header and branch picker off. Snippet for their developer:
//
//   <iframe src="https://portal.receptionmate.co.uk/embed/inbox"
//           style="width:100%;height:100%;border:0" allow="clipboard-write"></iframe>
export { default } from '../../messages/page';
