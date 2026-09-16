// Loaded only by subprocess tests; production code never reads these variables.
const mode = process.env.NAMESTACK_TEST_RESPONSE ?? "success";
const account = process.env.NAMESTACK_TEST_ACCOUNT;
globalThis.fetch = async (input, init) => {
  const url = new URL(String(input));
  if (url.origin !== "https://api.cloudflare.com" || !url.pathname.includes("/registrar/")) {
    throw new Error("Unexpected network destination in CLI test");
  }
  if (account && !url.pathname.startsWith(`/client/v4/accounts/${account}/`)) {
    throw new Error("Unexpected account in CLI test");
  }
  if (mode === "hang") {
    process.stderr.write("TEST_REQUEST_STARTED\n");
    return new Promise((_, reject) => {
      const timer = setTimeout(
        () => reject(new Error("test request unexpectedly finished")),
        60_000,
      );
      init.signal.addEventListener(
        "abort",
        () => {
          clearTimeout(timer);
          reject(init.signal.reason);
        },
        { once: true },
      );
    });
  }
  if (mode === "forbidden") return new Response(null, { status: 403 });
  if (mode === "malformed") return new Response("<html>bad gateway</html>");
  if (url.pathname.endsWith("domain-search")) {
    return Response.json({
      success: true,
      result: { domains: [{ name: "candidate.com", registrable: true, tier: "standard" }] },
    });
  }
  if (url.pathname.endsWith("extensions"))
    return Response.json({
      success: true,
      result: [{ metadata: { name: "com", tld: "com" } }],
      result_info: { cursor: "" },
    });
  const domains = JSON.parse(String(init.body)).domains;
  return Response.json({
    success: true,
    result: {
      domains: domains.map((name) => ({
        name,
        registrable: mode !== "unavailable",
        ...(mode === "unavailable"
          ? { reason: "domain_unavailable" }
          : {
              tier: "standard",
              pricing: { currency: "USD", registration_cost: "10.00", renewal_cost: "11.00" },
            }),
      })),
    },
  });
};
