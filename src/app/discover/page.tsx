/**
 * /discover — TikHub-driven product discovery MVP.
 *
 * Client-heavy page: server component here just gates on auth
 * and renders the DiscoverClient shell. All product fetching +
 * filtering + selection happens client-side via server actions
 * so tab-switching and filter changes feel instant.
 */

import { getCurrentWorkspace } from "@/lib/workspace";
import DiscoverClient from "./DiscoverClient";

export const dynamic = "force-dynamic";

export default async function DiscoverPage() {
  await getCurrentWorkspace();
  return <DiscoverClient />;
}
