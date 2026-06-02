import { redirect } from "next/navigation";
import AuthForm from "../(auth)/AuthForm";
import { getCurrentUser } from "@/lib/workspace";

export const dynamic = "force-dynamic";

export default async function SignupPage() {
  const user = await getCurrentUser({ optional: true });
  if (user) redirect("/dashboard");
  return <AuthForm variant="signup" />;
}
