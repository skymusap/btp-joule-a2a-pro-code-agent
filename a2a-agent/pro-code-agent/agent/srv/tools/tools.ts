import cds from "@sap/cds";
import { tool } from "@langchain/core/tools";
import type { StructuredToolInterface } from "@langchain/core/tools";
import {
    fetchDiscounts,
    fetchPaymentTerms,
    invokeSalesQuotationCreation,
    predictSalesQuotationScores
} from "../utils/sales-service";
import {
    AskExpert,
    AskExpertType,
    GetAllCombinations,
    PaymentTerms,
    PossibleDiscounts,
    SalesQuotation,
    ScoringSalesQuotationOptions
} from "../utils/types";
import { interrupt } from "@langchain/langgraph";
import { loadMcpTools } from "../utils/mcp-loader";
import { loadMcpSettings } from "../utils/mcp-settings";

const logger = cds.log("pro-code-agent", { label: "Tools" });

// ---------------------------------------------------------------------------
// Tools that are always present regardless of mode
// ---------------------------------------------------------------------------

const getAllCombinations = tool(
    async (input: any) => {
        const { paymentTerms, discounts }: { paymentTerms: string[]; discounts: string[] } = input;
        const combinations = [];
        for (const term of paymentTerms) {
            for (const discount of discounts) {
                combinations.push({ paymentTerm: term, discount: discount });
            }
        }
        return JSON.stringify(combinations);
    },
    {
        name: "get_all_combinations",
        description: "Get all combinations of payment terms and discounts.",
        schema: GetAllCombinations
    }
);

const askExpert = tool(
    async (input: any) => {
        const { questions }: AskExpertType = input;
        const answers = interrupt(questions);
        return { answers };
    },
    {
        name: "ask_expert",
        description:
            "Call this tool whenever you need additional information to e.g. call the other tools (if you miss the information to call them)",
        schema: AskExpert
    }
);

const predictSalesQuotationScoresTool = tool(
    async (input: any) => {
        const { customerName, salesInquiryID, paymentTermsAndDiscountsCombinations, taskType } = input;

        const options = paymentTermsAndDiscountsCombinations.map((combo: any) => ({
            customerName,
            salesInquiryID,
            paymentTerm: combo.paymentTerm,
            discount: combo.discount
        }));

        const result = await predictSalesQuotationScores(options, taskType);
        return result;
    },
    {
        name: "predict_sales_quotation_scores",
        description:
            "Predict scores for sales quotation option using RPT. Use regression for numeric predictoins (conversion rates, delays, ratings) or classification for categorical predictions. Defaults to classification.",
        schema: ScoringSalesQuotationOptions
    }
);

// ---------------------------------------------------------------------------
// Static mock sales tools (default mode)
// ---------------------------------------------------------------------------

const staticGetPaymentTerms = tool(
    async () => {
        const paymentTerms = await fetchPaymentTerms();
        return paymentTerms;
    },
    {
        name: "get_payment_terms",
        description: "Get the available payment terms from the system.",
        schema: PaymentTerms
    }
);

const staticGetPossibleDiscounts = tool(
    async () => {
        const discounts = await fetchDiscounts();
        return discounts;
    },
    {
        name: "get_possible_discounts",
        description: "Get the possible discount rates and their descriptions.",
        schema: PossibleDiscounts
    }
);

const staticCreateSalesQuotation = tool(
    async () => {
        const createdSalesQuotation = await invokeSalesQuotationCreation();
        return createdSalesQuotation;
    },
    {
        name: "create_sales_quotation",
        description: "Create a sales quotation in the system.",
        schema: SalesQuotation
    }
);

const staticSalesTools: StructuredToolInterface[] = [
    staticGetPaymentTerms,
    staticGetPossibleDiscounts,
    staticCreateSalesQuotation
];

// ---------------------------------------------------------------------------
// Tool loader — switches between static mock and MCP-backed S/4HANA tools
// ---------------------------------------------------------------------------

export async function loadTools(): Promise<StructuredToolInterface[]> {
    const alwaysOnTools: StructuredToolInterface[] = [askExpert, getAllCombinations, predictSalesQuotationScoresTool];

    const useMcp = (process.env.USE_MCP_SERVER ?? "").toLowerCase() === "true";

    if (!useMcp) {
        logger.info("[Tools] USE_MCP_SERVER not set — using static mock sales tools");
        return [...alwaysOnTools, ...staticSalesTools];
    }

    logger.info("[Tools] USE_MCP_SERVER=true — loading S/4HANA sales tools from MCP server");
    const mcpSettings = await loadMcpSettings();
    const mcpTools = await loadMcpTools(mcpSettings);

    if (mcpTools.length === 0) {
        logger.warn("[Tools] MCP server returned no tools — falling back to static mock sales tools");
        return [...alwaysOnTools, ...staticSalesTools];
    }

    return [...alwaysOnTools, ...mcpTools];
}
