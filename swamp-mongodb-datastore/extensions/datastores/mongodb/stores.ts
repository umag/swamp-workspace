// Narrow ports over the driver's `Collection`, listing only the members this
// extension calls. The real `Collection<T>` satisfies each structurally, and
// tests inject in-memory fakes without casts.
//
// Kept separate from config.ts (configuration) and never imported by
// extensions/models/ (packaging: each entry point ships only its own import
// graph).

import type { Binary } from "npm:mongodb@6.17.0";

export interface Cursor<T> extends AsyncIterable<T> {
  toArray(): Promise<T[]>;
  sort(spec: Record<string, 1 | -1>): Cursor<T>;
  limit(n: number): Cursor<T>;
  project(spec: Record<string, number>): Cursor<T>;
}

export interface Filter {
  [key: string]: unknown;
}

export interface BulkWriteResult {
  insertedCount?: number;
  upsertedCount?: number;
  modifiedCount?: number;
  matchedCount?: number;
  deletedCount?: number;
}

/** What every collection-backed store needs. */
export interface BaseStore<T extends { _id: string }> {
  createIndex(spec: Record<string, 1 | -1>): Promise<string>;
  find(
    filter?: Filter,
    opts?: { projection?: Record<string, number> },
  ): Cursor<T>;
  findOne(
    filter?: Filter,
    opts?: { projection?: Record<string, number> },
  ): Promise<T | null>;
  countDocuments(filter?: Filter, opts?: { limit?: number }): Promise<number>;
  insertOne(doc: T): Promise<unknown>;
  updateOne(
    filter: Filter,
    update: { $set?: Partial<T>; $setOnInsert?: Partial<T> },
    opts?: { upsert?: boolean },
  ): Promise<unknown>;
  deleteOne(filter: Filter): Promise<{ deletedCount: number }>;
  deleteMany(filter: Filter): Promise<{ deletedCount: number }>;
  bulkWrite(
    ops: Record<string, unknown>[],
    opts?: { ordered?: boolean },
  ): Promise<BulkWriteResult>;
}

export interface PathDoc {
  _id: string;
  hash: string;
  size: number;
  updatedAt: Date;
  deletedAt: Date | null;
}

export interface BlobDoc {
  _id: string;
  size: number;
  createdAt?: Date;
  data?: Binary;
  chunkCount?: number;
}

/** A `_control` document: one control-plane record. */
export interface ControlDoc {
  _id: string;
  data: Binary | Uint8Array;
  updatedAt: Date;
}

export type PathsStore = BaseStore<PathDoc>;
export type BlobsStore = BaseStore<BlobDoc>;
export type ControlStore = BaseStore<ControlDoc>;
