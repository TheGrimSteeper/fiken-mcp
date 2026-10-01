import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { mutate, cp } from "../client.js";

function ok(data: unknown) {
    return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
}
function err(e: unknown) {
    return {
        content: [
            { type: "text" as const, text: `Error: ${e instanceof Error ? e.message : String(e)}` },
        ],
        isError: true as const,
    };
}

const supplierSchema = z.object({
    name: z.string().min(1).describe("Supplier name as printed on the receipt or invoice"),
    organizationNumber: z
        .string()
        .regex(/^\d{9}$/, "organizationNumber must be 9 digits")
        .optional()
        .describe("Norwegian organisation number, 9 digits without spaces"),
    email: z.string().optional(),
    phoneNumber: z.string().optional(),
    bankAccountNumber: z.string().optional(),
    address: z
        .object({
            streetAddress: z.string().optional(),
            postCode: z.string().optional(),
            city: z.string().optional(),
            country: z.string().optional(),
        })
        .optional(),
});

export function register(server: McpServer) {
    server.registerTool(
        "fiken_create_supplier",
        {
            annotations: { readOnlyHint: false },
            description:
                "Creates a supplier contact. Look the supplier up with fiken_list_contacts first; only create it after the owner has confirmed in chat.",
            inputSchema: supplierSchema,
        },
        async (body) => {
            try {
                return ok(
                    await mutate("POST", cp("/contacts"), {
                        ...body,
                        supplier: true,
                        customer: false,
                    }),
                );
            } catch (e) {
                return err(e);
            }
        },
    );
}
