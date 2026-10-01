import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { DRAFT_TOOLS, assertAllRegistered, restrictTools, toolProfile } from "./profile.js";

import { register as registerUser } from "./tools/user.js";
import { register as registerAccounts } from "./tools/accounts.js";
import { register as registerContacts } from "./tools/contacts.js";
import { register as registerInvoices } from "./tools/invoices.js";
import { register as registerCreditNotes } from "./tools/creditNotes.js";
import { register as registerOffers } from "./tools/offers.js";
import { register as registerOrderConfirmations } from "./tools/orderConfirmations.js";
import { register as registerJournalEntries } from "./tools/journalEntries.js";
import { register as registerTransactions } from "./tools/transactions.js";
import { register as registerPurchases } from "./tools/purchases.js";
import { register as registerSales } from "./tools/sales.js";
import { register as registerMisc } from "./tools/misc.js";
import { register as registerSuppliers } from "./tools/suppliers.js";
import { register as registerPaperlessDrafts } from "./tools/paperlessDrafts.js";

/**
 * Build an MCP server. In the "drafts" profile only DRAFT_TOOLS are registered;
 * every other tool is left out entirely.
 */
export function createMcpServer(profile = toolProfile()): McpServer {
    const server = new McpServer({
        name: "fiken-mcp",
        version: "1.0.0",
    });
    const restricted = profile === "drafts" ? restrictTools(server, DRAFT_TOOLS) : undefined;
    const target = restricted?.server ?? server;

    registerUser(target);
    registerAccounts(target);
    registerContacts(target);
    registerInvoices(target);
    registerCreditNotes(target);
    registerOffers(target);
    registerOrderConfirmations(target);
    registerJournalEntries(target);
    registerTransactions(target);
    registerPurchases(target);
    registerSales(target);
    registerMisc(target);
    registerSuppliers(target);
    registerPaperlessDrafts(target);

    if (restricted) assertAllRegistered(DRAFT_TOOLS, restricted.registered());
    return server;
}
