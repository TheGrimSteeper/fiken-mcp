import { vi, describe, it, expect, beforeAll, beforeEach } from "vitest";

vi.mock("../../client.js", () => ({
    get: vi.fn(),
    mutate: vi.fn(),
    cp: vi.fn((path: string) => `/companies/test-slug${path}`),
    slug: vi.fn(() => "test-slug"),
}));

import { mutate } from "../../client.js";
import { register } from "../../tools/suppliers.js";
import { createMockServer } from "../helpers.js";

const mockMutate = vi.mocked(mutate);
const server = createMockServer();

beforeAll(() => {
    register(server);
});
beforeEach(() => {
    vi.clearAllMocks();
});

describe("fiken_create_supplier", () => {
    it("always creates a supplier, never a customer", async () => {
        mockMutate.mockResolvedValue({ created: true, location: "/contacts/7" });
        const result = await server.getHandler("fiken_create_supplier")({
            name: "Clas Ohlson AS",
            organizationNumber: "123456789",
            customer: true,
        } as never);
        expect(mockMutate).toHaveBeenCalledWith("POST", "/companies/test-slug/contacts", {
            name: "Clas Ohlson AS",
            organizationNumber: "123456789",
            customer: false,
            supplier: true,
        });
        expect(result.content[0].text).toBe(
            JSON.stringify({ created: true, location: "/contacts/7" }, null, 2),
        );
    });

    it("returns isError on failure", async () => {
        mockMutate.mockRejectedValue(new Error("Fiken 400: bad"));
        const result = await server.getHandler("fiken_create_supplier")({ name: "X" });
        expect(result.isError).toBe(true);
        expect(result.content[0].text).toBe("Error: Fiken 400: bad");
    });

    it("stringifies non-Error rejections", async () => {
        mockMutate.mockRejectedValue("boom");
        const result = await server.getHandler("fiken_create_supplier")({ name: "X" });
        expect(result.content[0].text).toBe("Error: boom");
    });
});
