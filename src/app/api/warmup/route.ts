import { fastGoto, getBrowser } from "@/lib/browser";

/** Launches the bridge browser (restoring the Amazon session) before the first question. */
export async function POST() {
  try {
    const { page } = await getBrowser();
    if (!page.url().includes("amazon.")) {
      await fastGoto("https://www.amazon.com");
    }
    return Response.json({ ok: true, url: page.url() });
  } catch (err) {
    return Response.json({ ok: false, error: String(err) }, { status: 500 });
  }
}
