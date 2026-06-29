export const onRequest = async (context) => {
  const { request, next } = context;
  const expected = "Basic " + btoa("fixmycar:Nomoremissedleads");
  const got = request.headers.get("Authorization") || "";
  if (got !== expected) {
    return new Response("Authentication required.", {
      status: 401,
      headers: { "WWW-Authenticate": "Basic realm=\"FixMyCar\", charset=\"UTF-8\"" },
    });
  }
  return next();
};
