export interface Utterance {
  id: string;
  text: string;
  timestamp: Date;
  status: 'pending' | 'delivered' | 'responded';
}

export interface UtteranceQueue {
  utterances: Utterance[];
  add(text: string): Utterance;
  getRecent(limit?: number): Utterance[];
  markDelivered(id: string): void;
  clear(): void;
}