/** The assistant's memory belongs to the hosted edition: the community edition remembers nothing. */
const none = { memory: null, loading: false, refresh: () => {}, update: async () => null };

export default function useAssistantMemory() {
  return none;
}
