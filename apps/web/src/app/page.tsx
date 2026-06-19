import { redirect } from 'next/navigation';
// Server component: send people to the dashboard; the dashboard bounces
// unauthenticated users to /login.
export default function Home() {
  redirect('/dashboard');
}
