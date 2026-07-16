export async function authorizeProvider(input: unknown) {
  return fetch("https://payments.example/authorize", {
    method: "POST",
    body: JSON.stringify(input)
  });
}
