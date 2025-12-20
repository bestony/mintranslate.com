import type { StandardSchemaV1 } from "@standard-schema/spec";
import type {
	Collection,
	PendingMutation,
	TransactionWithMutations,
} from "@tanstack/react-db";
import { waitFor } from "@testing-library/dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	type IndexedDBCollectionUtils,
	indexedDBCollectionOptions,
} from "./indexedDBCollectionOptions";

describe("indexedDBCollectionOptions", () => {
	// Mock IndexedDB
	let mockDB: {
		version: number;
		objectStoreNames: { contains: (name: string) => boolean };
		transaction: ReturnType<typeof vi.fn>;
		createObjectStore: ReturnType<typeof vi.fn>;
		close: ReturnType<typeof vi.fn>;
		addEventListener: ReturnType<typeof vi.fn>;
	};

	let mockTransaction: {
		objectStore: ReturnType<typeof vi.fn>;
		addEventListener: ReturnType<typeof vi.fn>;
		error?: Error | null;
	};

	let mockObjectStore: {
		getAll: ReturnType<typeof vi.fn>;
		put: ReturnType<typeof vi.fn>;
		delete: ReturnType<typeof vi.fn>;
		clear: ReturnType<typeof vi.fn>;
		createIndex: ReturnType<typeof vi.fn>;
		indexNames: { contains: (name: string) => boolean };
		count: ReturnType<typeof vi.fn>;
	};

	let mockRequest: {
		result: unknown;
		error: Error | null;
		addEventListener: ReturnType<typeof vi.fn>;
	};

	let openDBRequest: {
		result: typeof mockDB;
		transaction: typeof mockTransaction | null;
		error: Error | null;
		addEventListener: ReturnType<typeof vi.fn>;
	};

	const baseConfig = {
		databaseName: "test-db",
		storeName: "test-store",
		getKey: (item: { id: string }) => item.id,
	};

	const asMutations = <T extends object>(mutations: Array<unknown>) =>
		mutations as [PendingMutation<T>, ...Array<PendingMutation<T>>];

	const asTransaction = <
		T extends object,
		TOperation extends "insert" | "update" | "delete",
	>(
		mutations: Array<unknown>,
	) => ({ mutations }) as unknown as TransactionWithMutations<T, TOperation>;

	const createMockSyncParams = <T extends object>() => ({
		collection: {} as Collection<T, string, IndexedDBCollectionUtils>,
		begin: vi.fn(),
		write: vi.fn(),
		commit: vi.fn(),
		markReady: vi.fn(),
		truncate: vi.fn(),
	});

	const createMockCollection = <T extends object>() =>
		({}) as Collection<T, string, IndexedDBCollectionUtils>;

	beforeEach(() => {
		// Reset all mocks
		vi.clearAllMocks();

		// Setup mock object store
		mockObjectStore = {
			getAll: vi.fn(),
			put: vi.fn(),
			delete: vi.fn(),
			clear: vi.fn(),
			createIndex: vi.fn(),
			indexNames: { contains: vi.fn(() => false) },
			count: vi.fn(),
		};

		// Setup mock transaction
		mockTransaction = {
			objectStore: vi.fn(() => mockObjectStore),
			addEventListener: vi.fn((event: string, handler: () => void) => {
				if (event === "complete") {
					// Immediately resolve transaction
					setTimeout(handler, 0);
				}
			}),
		};

		// Setup mock database
		mockDB = {
			version: 1,
			objectStoreNames: {
				contains: vi.fn(() => false),
			},
			transaction: vi.fn(() => mockTransaction),
			createObjectStore: vi.fn(() => mockObjectStore),
			close: vi.fn(),
			addEventListener: vi.fn(),
		};

		// Setup mock request
		mockRequest = {
			result: [],
			error: null,
			addEventListener: vi.fn((event: string, handler: () => void) => {
				if (event === "success") {
					setTimeout(handler, 0);
				}
			}),
		};

		// Setup open request
		openDBRequest = {
			result: mockDB,
			transaction: null,
			error: null,
			addEventListener: vi.fn((event: string, handler: () => void) => {
				if (event === "success") {
					setTimeout(handler, 0);
				}
			}),
		};

		// Mock IndexedDB API
		Object.defineProperty(globalThis, "indexedDB", {
			value: {
				open: vi.fn(() => openDBRequest),
			},
			writable: true,
			configurable: true,
		});
	});

	describe("basic configuration", () => {
		it("creates collection with minimum required config", () => {
			const config = indexedDBCollectionOptions({
				...baseConfig,
			});

			expect(config.id).toBe("indexeddb-collection:test-db/test-store");
			expect(config.sync).toBeDefined();
			expect(config.onInsert).toBeDefined();
			expect(config.onUpdate).toBeDefined();
			expect(config.onDelete).toBeDefined();
			expect(config.utils.clearStore).toBeDefined();
		});

		it("uses custom id when provided", () => {
			const config = indexedDBCollectionOptions({
				...baseConfig,
				id: "custom-id",
			});

			expect(config.id).toBe("custom-id");
		});

		it("passes through additional config properties", () => {
			const config = indexedDBCollectionOptions({
				...baseConfig,
				gcTime: 1234,
			});

			expect(config.gcTime).toBe(1234);
		});

		it("handles schema when provided", () => {
			const mockSchema: StandardSchemaV1<unknown, { id: string }> = {
				"~standard": {
					version: 1,
					vendor: "test",
					validate: (value: unknown) => ({ value: value as { id: string } }),
				},
			};

			const config = indexedDBCollectionOptions({
				...baseConfig,
				schema: mockSchema,
			});

			expect(config.schema).toBe(mockSchema);
		});
	});

	describe("sync functionality", () => {
		it("provides sync metadata", () => {
			const config = indexedDBCollectionOptions({
				...baseConfig,
				version: 5,
			});

			const metadata = config.sync.getSyncMetadata?.();
			expect(metadata).toEqual({
				databaseName: baseConfig.databaseName,
				storeName: baseConfig.storeName,
				version: 5,
			});
		});

		it("defaults to version 1 when not provided", () => {
			const config = indexedDBCollectionOptions({
				...baseConfig,
			});

			const metadata = config.sync.getSyncMetadata?.();
			expect(metadata?.version).toBe(1);
		});

		it("syncs data from IndexedDB on initialization", async () => {
			mockObjectStore.getAll.mockReturnValue(mockRequest);
			mockRequest.result = [
				{ value: { id: "1", name: "Item 1" }, updatedAt: 123 },
				{ value: { id: "2", name: "Item 2" }, updatedAt: 456 },
			];

			const config = indexedDBCollectionOptions({
				...baseConfig,
			});

			const mockSyncParams = createMockSyncParams<{ id: string }>();

			config.sync.sync(mockSyncParams);

			await waitFor(() => {
				expect(mockSyncParams.markReady).toHaveBeenCalledTimes(1);
			});

			expect(mockSyncParams.begin).toHaveBeenCalledTimes(1);
			expect(mockSyncParams.write).toHaveBeenCalledTimes(2);
			expect(mockSyncParams.write).toHaveBeenNthCalledWith(1, {
				type: "insert",
				value: { id: "1", name: "Item 1" },
			});
			expect(mockSyncParams.write).toHaveBeenNthCalledWith(2, {
				type: "insert",
				value: { id: "2", name: "Item 2" },
			});
			expect(mockSyncParams.commit).toHaveBeenCalledTimes(1);
			expect(mockSyncParams.markReady).toHaveBeenCalledTimes(1);
		});

		it("marks ready even when sync fails", async () => {
			const consoleErrorSpy = vi
				.spyOn(console, "error")
				.mockImplementation(() => {});

			// Make the open fail
			openDBRequest.addEventListener = vi.fn((event: string, handler) => {
				if (event === "error") {
					setTimeout(handler, 0);
				}
			});
			openDBRequest.error = new Error("DB open failed");

			const config = indexedDBCollectionOptions({
				...baseConfig,
			});

			const mockSyncParams = createMockSyncParams<{ id: string }>();

			config.sync.sync(mockSyncParams);

			await waitFor(() => {
				expect(mockSyncParams.markReady).toHaveBeenCalledTimes(1);
			});

			expect(mockSyncParams.markReady).toHaveBeenCalledTimes(1);
			expect(consoleErrorSpy).toHaveBeenCalled();

			consoleErrorSpy.mockRestore();
		});

		it("does not call begin/write/commit when no data exists", async () => {
			mockObjectStore.getAll.mockReturnValue(mockRequest);
			mockRequest.result = [];

			const config = indexedDBCollectionOptions({
				...baseConfig,
			});

			const mockSyncParams = createMockSyncParams<{ id: string }>();

			config.sync.sync(mockSyncParams);

			await waitFor(() => {
				expect(mockSyncParams.markReady).toHaveBeenCalledTimes(1);
			});

			expect(mockSyncParams.begin).not.toHaveBeenCalled();
			expect(mockSyncParams.write).not.toHaveBeenCalled();
			expect(mockSyncParams.commit).not.toHaveBeenCalled();
			expect(mockSyncParams.markReady).toHaveBeenCalledTimes(1);
		});

		it("returns cleanup function from sync", () => {
			mockObjectStore.getAll.mockReturnValue(mockRequest);
			mockRequest.result = [];

			const config = indexedDBCollectionOptions({
				...baseConfig,
			});

			const mockSyncParams = createMockSyncParams<{ id: string }>();

			const cleanup = config.sync.sync(mockSyncParams);

			// Should return a function
			expect(typeof cleanup).toBe("function");

			// Call cleanup to cover the cleanup function body
			if (typeof cleanup === "function") {
				cleanup();
			}
		});

		it("can cancel sync before database is ready", async () => {
			let resolveDB!: (value: IDBDatabase) => void;
			const dbPromise = new Promise<IDBDatabase>((resolve) => {
				resolveDB = resolve;
			});

			// Make indexedDB.open return a delayed promise
			Object.defineProperty(globalThis, "indexedDB", {
				value: {
					open: vi.fn(() => ({
						result: mockDB,
						transaction: null,
						error: null,
						addEventListener: vi.fn((event: string, handler: () => void) => {
							if (event === "success") {
								dbPromise.then(() => setTimeout(handler, 0));
							}
						}),
					})),
				},
				writable: true,
				configurable: true,
			});

			mockObjectStore.getAll.mockReturnValue(mockRequest);
			mockRequest.result = [{ value: { id: "1" }, updatedAt: 123 }];

			const config = indexedDBCollectionOptions({
				...baseConfig,
			});

			const mockSyncParams = createMockSyncParams<{ id: string }>();

			const cleanup = config.sync.sync(mockSyncParams);

			// Cancel before DB is ready
			if (typeof cleanup === "function") {
				cleanup();
			}

			// Now resolve the DB
			resolveDB(mockDB as unknown as IDBDatabase);

			await new Promise((resolve) => setTimeout(resolve, 20));

			// Operations should not have been called because of cancel
			expect(mockSyncParams.begin).not.toHaveBeenCalled();
		});

		it("can cancel sync after database but before data fetch", async () => {
			let resolveGetAll!: (value: unknown) => void;
			const getAllPromise = new Promise((resolve) => {
				resolveGetAll = resolve;
			});

			const delayedRequest = {
				result: [{ value: { id: "1" }, updatedAt: 123 }],
				error: null,
				addEventListener: vi.fn((event: string, handler: () => void) => {
					if (event === "success") {
						getAllPromise.then(() => setTimeout(handler, 0));
					}
				}),
			};

			mockObjectStore.getAll.mockReturnValue(delayedRequest);

			const config = indexedDBCollectionOptions({
				...baseConfig,
			});

			const mockSyncParams = createMockSyncParams<{ id: string }>();

			const cleanup = config.sync.sync(mockSyncParams);

			// Wait for DB to open
			await new Promise((resolve) => setTimeout(resolve, 5));

			// Cancel after DB is open but before getAll completes
			if (typeof cleanup === "function") {
				cleanup();
			}

			// Now resolve getAll
			resolveGetAll(undefined);

			await new Promise((resolve) => setTimeout(resolve, 20));

			// Operations should not have been called because of cancel
			expect(mockSyncParams.begin).not.toHaveBeenCalled();
		});
	});

	describe("mutation handlers", () => {
		it("handles insert mutations", async () => {
			mockObjectStore.getAll.mockReturnValue(mockRequest);
			mockObjectStore.put.mockReturnValue(mockRequest);

			const config = indexedDBCollectionOptions({
				...baseConfig,
			});
			const collection = createMockCollection<{ id: string }>();

			const mutations = asMutations<{ id: string; name: string }>([
				{
					type: "insert",
					key: "1",
					modified: { id: "1", name: "New Item" },
					original: null,
				},
			]);

			await config.onInsert?.({
				collection,
				transaction: asTransaction<{ id: string }, "insert">(mutations),
			});

			expect(mockObjectStore.put).toHaveBeenCalled();
		});

		it("handles update mutations", async () => {
			mockObjectStore.getAll.mockReturnValue(mockRequest);
			mockObjectStore.put.mockReturnValue(mockRequest);

			const config = indexedDBCollectionOptions({
				...baseConfig,
			});
			const collection = createMockCollection<{ id: string }>();

			const mutations = asMutations<{ id: string; name: string }>([
				{
					type: "update",
					key: "1",
					modified: { id: "1", name: "Updated Item" },
					original: { id: "1", name: "Old Item" },
				},
			]);

			await config.onUpdate?.({
				collection,
				transaction: asTransaction<{ id: string }, "update">(mutations),
			});

			expect(mockObjectStore.put).toHaveBeenCalled();
		});

		it("handles delete mutations", async () => {
			mockObjectStore.getAll.mockReturnValue(mockRequest);
			mockObjectStore.delete.mockReturnValue(mockRequest);

			const config = indexedDBCollectionOptions({
				...baseConfig,
			});
			const collection = createMockCollection<{ id: string }>();

			const mutations = asMutations<{ id: string; name: string }>([
				{
					type: "delete",
					key: "1",
					modified: null,
					original: { id: "1", name: "Deleted Item" },
				},
			]);

			await config.onDelete?.({
				collection,
				transaction: asTransaction<{ id: string }, "delete">(mutations),
			});

			expect(mockObjectStore.delete).toHaveBeenCalled();
		});

		it("calls custom onInsert handler when provided", async () => {
			mockObjectStore.getAll.mockReturnValue(mockRequest);
			mockObjectStore.put.mockReturnValue(mockRequest);

			const customOnInsert = vi.fn().mockResolvedValue({ custom: "result" });

			const config = indexedDBCollectionOptions({
				...baseConfig,
				onInsert: customOnInsert,
			});
			const collection = createMockCollection<{ id: string }>();

			const mutations = asMutations<{ id: string }>([
				{ type: "insert", key: "1", modified: { id: "1" }, original: null },
			]);

			const result = await config.onInsert?.({
				collection,
				transaction: asTransaction<{ id: string }, "insert">(mutations),
			});

			expect(customOnInsert).toHaveBeenCalled();
			expect(result).toEqual({ custom: "result" });
		});

		it("calls custom onUpdate handler when provided", async () => {
			mockObjectStore.getAll.mockReturnValue(mockRequest);
			mockObjectStore.put.mockReturnValue(mockRequest);

			const customOnUpdate = vi.fn().mockResolvedValue({ custom: "result" });

			const config = indexedDBCollectionOptions({
				...baseConfig,
				onUpdate: customOnUpdate,
			});
			const collection = createMockCollection<{ id: string }>();

			const mutations = asMutations<{ id: string }>([
				{
					type: "update",
					key: "1",
					modified: { id: "1" },
					original: { id: "1" },
				},
			]);

			const result = await config.onUpdate?.({
				collection,
				transaction: asTransaction<{ id: string }, "update">(mutations),
			});

			expect(customOnUpdate).toHaveBeenCalled();
			expect(result).toEqual({ custom: "result" });
		});

		it("calls custom onDelete handler when provided", async () => {
			mockObjectStore.getAll.mockReturnValue(mockRequest);
			mockObjectStore.delete.mockReturnValue(mockRequest);

			const customOnDelete = vi.fn().mockResolvedValue({ custom: "result" });

			const config = indexedDBCollectionOptions({
				...baseConfig,
				onDelete: customOnDelete,
			});
			const collection = createMockCollection<{ id: string }>();

			const mutations = asMutations<{ id: string }>([
				{
					type: "delete",
					key: "1",
					modified: null,
					original: { id: "1" },
				},
			]);

			const result = await config.onDelete?.({
				collection,
				transaction: asTransaction<{ id: string }, "delete">(mutations),
			});

			expect(customOnDelete).toHaveBeenCalled();
			expect(result).toEqual({ custom: "result" });
		});

		it("confirms sync operations after insert", async () => {
			mockObjectStore.getAll.mockReturnValue(mockRequest);
			mockObjectStore.put.mockReturnValue(mockRequest);

			const config = indexedDBCollectionOptions({
				...baseConfig,
			});
			const collection = createMockCollection<{ id: string }>();

			// Initialize sync first
			const mockSyncParams = createMockSyncParams<{ id: string }>();
			config.sync.sync(mockSyncParams);
			await waitFor(() => {
				expect(mockSyncParams.markReady).toHaveBeenCalledTimes(1);
			});

			// Reset the mocks to track new calls
			mockSyncParams.begin.mockClear();
			mockSyncParams.write.mockClear();
			mockSyncParams.commit.mockClear();

			const mutations = asMutations<{ id: string }>([
				{ type: "insert", key: "1", modified: { id: "1" }, original: null },
			]);

			await config.onInsert?.({
				collection,
				transaction: asTransaction<{ id: string }, "insert">(mutations),
			});

			expect(mockSyncParams.begin).toHaveBeenCalled();
			expect(mockSyncParams.write).toHaveBeenCalledWith({
				type: "insert",
				value: { id: "1" },
			});
			expect(mockSyncParams.commit).toHaveBeenCalled();
		});
	});

	describe("utils.clearStore", () => {
		it("clears the object store", async () => {
			mockObjectStore.getAll.mockReturnValue(mockRequest);
			mockObjectStore.clear.mockReturnValue(mockRequest);

			const config = indexedDBCollectionOptions({
				...baseConfig,
			});

			await config.utils.clearStore();

			expect(mockObjectStore.clear).toHaveBeenCalled();
		});
	});

	describe("database initialization", () => {
		it("opens database without version", async () => {
			const config = indexedDBCollectionOptions({
				...baseConfig,
			});

			// Trigger database open
			await config.utils.clearStore();

			expect(globalThis.indexedDB.open).toHaveBeenCalled();
		});

		it("creates object store on upgrade", async () => {
			openDBRequest.transaction = mockTransaction;
			openDBRequest.addEventListener = vi.fn((event: string, handler) => {
				if (event === "upgradeneeded" || event === "success") {
					setTimeout(handler, 0);
				}
			});

			const config = indexedDBCollectionOptions({
				...baseConfig,
			});

			await config.utils.clearStore();

			expect(mockDB.createObjectStore).toHaveBeenCalledWith("test-store");
		});

		it("creates indexes during upgrade", async () => {
			openDBRequest.transaction = mockTransaction;
			openDBRequest.addEventListener = vi.fn((event: string, handler) => {
				if (event === "upgradeneeded" || event === "success") {
					setTimeout(handler, 0);
				}
			});

			const config = indexedDBCollectionOptions({
				...baseConfig,
				indexes: [
					{ name: "byName", keyPath: "name" },
					{ name: "byEmail", keyPath: "email", options: { unique: true } },
				],
			});

			await config.utils.clearStore();

			expect(mockObjectStore.createIndex).toHaveBeenCalledWith(
				"byName",
				"name",
				undefined,
			);
			expect(mockObjectStore.createIndex).toHaveBeenCalledWith(
				"byEmail",
				"email",
				{ unique: true },
			);
		});

		it("does not recreate existing indexes", async () => {
			mockDB.version = 1;
			mockDB.objectStoreNames.contains = vi.fn(() => true);
			mockObjectStore.indexNames.contains = vi.fn(
				(name: string) => name === "byName",
			);

			openDBRequest.transaction = mockTransaction;
			openDBRequest.addEventListener = vi.fn((event: string, handler) => {
				if (event === "upgradeneeded" || event === "success") {
					setTimeout(handler, 0);
				}
			});

			const config = indexedDBCollectionOptions({
				...baseConfig,
				version: 1,
				indexes: [
					{ name: "byName", keyPath: "name" },
					{ name: "byEmail", keyPath: "email" },
				],
			});

			await config.utils.clearStore();

			// byEmail should be created (doesn't exist), byName should not (already exists)
			expect(mockObjectStore.createIndex).toHaveBeenCalledWith(
				"byEmail",
				"email",
				undefined,
			);
			expect(mockObjectStore.createIndex).not.toHaveBeenCalledWith(
				"byName",
				"name",
				undefined,
			);
		});

		it("upgrades database when needed", async () => {
			// First open - old version
			mockDB.version = 1;
			mockDB.objectStoreNames.contains = vi.fn(() => true);
			mockObjectStore.count.mockReturnValue(mockRequest);

			openDBRequest.addEventListener = vi.fn((event: string, handler) => {
				if (event === "success") {
					setTimeout(handler, 0);
				}
			});

			const config = indexedDBCollectionOptions({
				...baseConfig,
				version: 2,
			});

			await config.utils.clearStore();

			expect(mockDB.close).toHaveBeenCalled();
			expect(globalThis.indexedDB.open).toHaveBeenCalledTimes(2);
		});

		it("does not upgrade when version is sufficient", async () => {
			mockDB.version = 3;
			mockDB.objectStoreNames.contains = vi.fn(() => true);

			openDBRequest.addEventListener = vi.fn((event: string, handler) => {
				if (event === "success") {
					setTimeout(handler, 0);
				}
			});

			const config = indexedDBCollectionOptions({
				...baseConfig,
				version: 2,
			});

			await config.utils.clearStore();

			expect(mockDB.close).not.toHaveBeenCalled();
			expect(globalThis.indexedDB.open).toHaveBeenCalledTimes(1);
		});

		it("closes database on version change", async () => {
			openDBRequest.addEventListener = vi.fn((event: string, handler) => {
				if (event === "success") {
					setTimeout(handler, 0);
				}
			});

			const config = indexedDBCollectionOptions({
				...baseConfig,
			});

			await config.utils.clearStore();

			expect(mockDB.addEventListener).toHaveBeenCalledWith(
				"versionchange",
				expect.any(Function),
			);

			// Trigger versionchange event
			const versionChangeHandler = mockDB.addEventListener.mock.calls.find(
				(call) => call[0] === "versionchange",
			)?.[1];
			versionChangeHandler?.();

			expect(mockDB.close).toHaveBeenCalled();
		});

		it("rejects when IndexedDB is not available", async () => {
			Object.defineProperty(globalThis, "indexedDB", {
				value: undefined,
				writable: true,
				configurable: true,
			});

			const config = indexedDBCollectionOptions({
				...baseConfig,
			});

			await expect(config.utils.clearStore()).rejects.toThrow(
				"IndexedDB is not available in this environment",
			);
		});

		it("handles database open errors", async () => {
			openDBRequest.error = new Error("Failed to open");
			openDBRequest.addEventListener = vi.fn((event: string, handler) => {
				if (event === "error") {
					setTimeout(handler, 0);
				}
			});

			const config = indexedDBCollectionOptions({
				...baseConfig,
			});

			await expect(config.utils.clearStore()).rejects.toThrow("Failed to open");
		});

		it("handles transaction errors", async () => {
			mockObjectStore.clear.mockReturnValue(mockRequest);
			mockTransaction.addEventListener = vi.fn((event: string, handler) => {
				if (event === "error") {
					setTimeout(handler, 0);
				}
			});
			mockTransaction.error = new Error("Transaction failed");

			const config = indexedDBCollectionOptions({
				...baseConfig,
			});

			await expect(config.utils.clearStore()).rejects.toThrow(
				"Transaction failed",
			);
		});

		it("handles transaction abort errors", async () => {
			mockObjectStore.clear.mockReturnValue(mockRequest);
			const abortError = new Error("Transaction aborted");
			mockTransaction.error = abortError;
			mockTransaction.addEventListener = vi.fn(
				(event: string, handler: () => void) => {
					if (event === "abort") {
						setTimeout(handler, 0);
					}
				},
			);

			const config = indexedDBCollectionOptions({
				...baseConfig,
			});

			await expect(config.utils.clearStore()).rejects.toThrow(
				"Transaction aborted",
			);
		});

		it("handles transaction abort without error object", async () => {
			mockObjectStore.clear.mockReturnValue(mockRequest);
			mockTransaction.error = null;
			mockTransaction.addEventListener = vi.fn(
				(event: string, handler: () => void) => {
					if (event === "abort") {
						setTimeout(handler, 0);
					}
				},
			);

			const config = indexedDBCollectionOptions({
				...baseConfig,
			});

			await expect(config.utils.clearStore()).rejects.toThrow(
				"IndexedDB transaction aborted",
			);
		});

		it("handles transaction error without error object", async () => {
			mockObjectStore.clear.mockReturnValue(mockRequest);
			mockTransaction.error = null;
			mockTransaction.addEventListener = vi.fn(
				(event: string, handler: () => void) => {
					if (event === "error") {
						setTimeout(handler, 0);
					}
				},
			);

			const config = indexedDBCollectionOptions({
				...baseConfig,
			});

			await expect(config.utils.clearStore()).rejects.toThrow(
				"IndexedDB transaction failed",
			);
		});

		it("handles database open error without error object", async () => {
			openDBRequest.error = null;
			openDBRequest.addEventListener = vi.fn((event: string, handler) => {
				if (event === "error") {
					setTimeout(handler, 0);
				}
			});

			const config = indexedDBCollectionOptions({
				...baseConfig,
			});

			await expect(config.utils.clearStore()).rejects.toThrow(
				"IndexedDB open failed",
			);
		});
	});

	describe("edge cases", () => {
		it("writes delete to sync when original has values", async () => {
			mockObjectStore.getAll.mockReturnValue(mockRequest);
			mockObjectStore.delete.mockReturnValue(mockRequest);

			const config = indexedDBCollectionOptions({
				...baseConfig,
			});
			const collection = createMockCollection<{ id: string }>();

			const mockSyncParams = createMockSyncParams<{ id: string }>();
			config.sync.sync(mockSyncParams);
			await waitFor(() => {
				expect(mockSyncParams.markReady).toHaveBeenCalledTimes(1);
			});

			mockSyncParams.begin.mockClear();
			mockSyncParams.write.mockClear();
			mockSyncParams.commit.mockClear();

			const mutations = asMutations<{ id: string; name: string }>([
				{
					type: "delete",
					key: "1",
					modified: null,
					original: { id: "1", name: "Item" },
				},
			]);

			await config.onDelete?.({
				collection,
				transaction: asTransaction<{ id: string }, "delete">(mutations),
			});

			expect(mockSyncParams.begin).toHaveBeenCalled();
			expect(mockSyncParams.write).toHaveBeenCalledWith({
				type: "delete",
				value: { id: "1", name: "Item" },
			});
			expect(mockSyncParams.commit).toHaveBeenCalled();
		});

		it("handles delete mutation without original value", async () => {
			mockObjectStore.getAll.mockReturnValue(mockRequest);
			mockObjectStore.delete.mockReturnValue(mockRequest);

			const config = indexedDBCollectionOptions({
				...baseConfig,
			});
			const collection = createMockCollection<{ id: string }>();

			const mockSyncParams = createMockSyncParams<{ id: string }>();
			config.sync.sync(mockSyncParams);
			await waitFor(() => {
				expect(mockSyncParams.markReady).toHaveBeenCalledTimes(1);
			});

			mockSyncParams.begin.mockClear();
			mockSyncParams.write.mockClear();
			mockSyncParams.commit.mockClear();

			const mutations = asMutations<{ id: string }>([
				{ type: "delete", key: "1", modified: null, original: null },
			]);

			await config.onDelete?.({
				collection,
				transaction: asTransaction<{ id: string }, "delete">(mutations),
			});

			// Should not write delete to sync when original is null
			expect(mockSyncParams.write).not.toHaveBeenCalled();
		});

		it("handles delete mutation with empty original object", async () => {
			mockObjectStore.getAll.mockReturnValue(mockRequest);
			mockObjectStore.delete.mockReturnValue(mockRequest);

			const config = indexedDBCollectionOptions({
				...baseConfig,
			});
			const collection = createMockCollection<{ id: string }>();

			const mockSyncParams = createMockSyncParams<{ id: string }>();
			config.sync.sync(mockSyncParams);
			await waitFor(() => {
				expect(mockSyncParams.markReady).toHaveBeenCalledTimes(1);
			});

			mockSyncParams.begin.mockClear();
			mockSyncParams.write.mockClear();
			mockSyncParams.commit.mockClear();

			const mutations = asMutations<Record<string, never>>([
				{ type: "delete", key: "1", modified: null, original: {} },
			]);

			await config.onDelete?.({
				collection,
				transaction: asTransaction<{ id: string }, "delete">(mutations),
			});

			// Should not write delete to sync when original is empty
			expect(mockSyncParams.write).not.toHaveBeenCalled();
		});

		it("handles multiple mutations in single transaction", async () => {
			mockObjectStore.getAll.mockReturnValue(mockRequest);
			mockObjectStore.put.mockReturnValue(mockRequest);
			mockObjectStore.delete.mockReturnValue(mockRequest);

			const config = indexedDBCollectionOptions({
				...baseConfig,
			});
			const collection = createMockCollection<{ id: string }>();

			const mutations = asMutations<{ id: string }>([
				{ type: "insert", key: "1", modified: { id: "1" }, original: null },
				{
					type: "update",
					key: "2",
					modified: { id: "2" },
					original: { id: "2" },
				},
				{
					type: "delete",
					key: "3",
					modified: null,
					original: { id: "3" },
				},
			]);

			await config.onInsert?.({
				collection,
				transaction: asTransaction<{ id: string }, "insert">(mutations),
			});

			expect(mockObjectStore.put).toHaveBeenCalledTimes(2);
			expect(mockObjectStore.delete).toHaveBeenCalledTimes(1);
		});

		it("handles missing upgrade transaction gracefully", async () => {
			openDBRequest.transaction = null;
			openDBRequest.addEventListener = vi.fn((event: string, handler) => {
				if (event === "upgradeneeded") {
					setTimeout(handler, 0);
				}
			});

			const config = indexedDBCollectionOptions({
				...baseConfig,
			});

			await expect(config.utils.clearStore()).rejects.toThrow(
				"IndexedDB upgrade transaction missing",
			);
		});

		it("reuses existing object store during upgrade", async () => {
			mockDB.objectStoreNames.contains = vi.fn(() => true);
			openDBRequest.transaction = mockTransaction;
			openDBRequest.addEventListener = vi.fn((event: string, handler) => {
				if (event === "upgradeneeded" || event === "success") {
					setTimeout(handler, 0);
				}
			});

			const config = indexedDBCollectionOptions({
				...baseConfig,
			});

			await config.utils.clearStore();

			expect(mockDB.createObjectStore).not.toHaveBeenCalled();
			expect(mockTransaction.objectStore).toHaveBeenCalledWith("test-store");
		});

		it("handles custom onInsert returning undefined", async () => {
			mockObjectStore.getAll.mockReturnValue(mockRequest);
			mockObjectStore.put.mockReturnValue(mockRequest);

			const customOnInsert = vi.fn().mockResolvedValue(undefined);

			const config = indexedDBCollectionOptions({
				...baseConfig,
				onInsert: customOnInsert,
			});
			const collection = createMockCollection<{ id: string }>();

			const mutations = asMutations<{ id: string }>([
				{ type: "insert", key: "1", modified: { id: "1" }, original: null },
			]);

			const result = await config.onInsert?.({
				collection,
				transaction: asTransaction<{ id: string }, "insert">(mutations),
			});

			expect(result).toEqual({});
		});

		it("handles custom onUpdate returning undefined", async () => {
			mockObjectStore.getAll.mockReturnValue(mockRequest);
			mockObjectStore.put.mockReturnValue(mockRequest);

			const customOnUpdate = vi.fn().mockResolvedValue(undefined);

			const config = indexedDBCollectionOptions({
				...baseConfig,
				onUpdate: customOnUpdate,
			});
			const collection = createMockCollection<{ id: string }>();

			const mutations = asMutations<{ id: string }>([
				{
					type: "update",
					key: "1",
					modified: { id: "1" },
					original: { id: "1" },
				},
			]);

			const result = await config.onUpdate?.({
				collection,
				transaction: asTransaction<{ id: string }, "update">(mutations),
			});

			expect(result).toEqual({});
		});

		it("handles custom onDelete returning undefined", async () => {
			mockObjectStore.getAll.mockReturnValue(mockRequest);
			mockObjectStore.delete.mockReturnValue(mockRequest);

			const customOnDelete = vi.fn().mockResolvedValue(undefined);

			const config = indexedDBCollectionOptions({
				...baseConfig,
				onDelete: customOnDelete,
			});
			const collection = createMockCollection<{ id: string }>();

			const mutations = asMutations<{ id: string }>([
				{
					type: "delete",
					key: "1",
					modified: null,
					original: { id: "1" },
				},
			]);

			const result = await config.onDelete?.({
				collection,
				transaction: asTransaction<{ id: string }, "delete">(mutations),
			});

			expect(result).toEqual({});
		});
	});
});
