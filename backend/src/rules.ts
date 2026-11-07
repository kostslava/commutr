// Non-scoring rules for rewards and saved locations, kept in one place.
// (Scoring numbers live in ./scoring/config.ts.)

/** How many times a user can redeem the same reward per Toronto calendar day. */
export const REDEMPTIONS_PER_REWARD_PER_DAY = 1;

/** Demo redemption codes look like CMTR-7F3K-Q2PX. No 0/O or 1/I, to avoid misreading. */
export const REDEMPTION_CODE_PREFIX = 'CMTR';
export const REDEMPTION_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
export const REDEMPTION_CODE_GROUPS = 2;
export const REDEMPTION_CODE_GROUP_LENGTH = 4;

/** Saved locations: at most one home per user (a new home replaces it), and a cap on favourites. */
export const LOCATION_KINDS = ['home', 'favourite'] as const;
export type LocationKind = (typeof LOCATION_KINDS)[number];
export const MAX_FAVOURITES = 20;
export const LOCATION_LABEL_MAX = 50;
