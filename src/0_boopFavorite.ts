export type BoopFavorite = {
  favorite_id: number;
  note: string;
  source: string;
  created_ts: number;
  bytes: number;
  body: string;
  tags?: string[];
};

export interface BoopConversation<TTurn> {
  readonly session: string;
  turns(): Promise<TTurn[]>;
  favorites(): Promise<BoopFavorite[]>;
  toggleFavorite(turn: TTurn): Promise<BoopFavorite[]>;
}
