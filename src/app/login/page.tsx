import { redirect } from "next/navigation";
import AuthForm from "../(auth)/AuthForm";
import { getCurrentUser } from "@/lib/workspace";

export const dynamic = "force-dynamic";

export default async function LoginPage() {
  // Already signed in? Bounce to the dashboard rather than render
  // the form — avoids the "I'm logged in but I see /login" surprise.
  const user = await getCurrentUser({ optional: true });
  if (user) redirect("/dashboard");
  return <AuthForm variant="login" />;
}
