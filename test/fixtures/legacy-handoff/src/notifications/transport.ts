export async function enqueue(topic: string, payload: unknown) {
  return { topic, payload };
}
