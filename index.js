const express = require("express");

const app = express();
app.use(express.json());

/* ---------------- HELPERS ---------------- */

function assertEnv() {
  if (!process.env.SUMMIT_COMPANY_ID || !process.env.SUMMIT_API_KEY) {
    throw new Error("Missing Summit credentials in env variables");
  }
}

function getCustomerExternalIdentifier(saved) {
  if (!saved || !saved.customerexternalidentifier) {
    throw new Error("customerexternalidentifier is required");
  }
  return String(saved.customerexternalidentifier);
}

function getPersonId(saved) {
  if (!saved || !saved.personid) {
    throw new Error("personid is required");
  }
  // מסיר רווחים – Summit מצפה למספר רציף
  return String(saved.personid).replace(/\s+/g, "");
}

/* ---------------- SUMMIT RESPONSE HANDLER ---------------- */

function unwrapSummit(response) {
  if (!response || response.Status === undefined) {
    throw new Error("Invalid response from Summit");
  }

  if (response.Status !== 0) {
    throw new Error(
      response.UserErrorMessage ||
      response.TechnicalErrorDetails ||
      "Summit returned an error"
    );
  }

  return response.Data || {};
}

/* ---------------- SUMMIT: DOCUMENT ---------------- */

async function createInvoiceAndReceipt({
  saved,
  amount,
  last4,
  payments,
  sku
}) {
  assertEnv();

  if (!sku) {
    throw new Error("SKU Item is required");
  }

  if (!amount) {
    throw new Error("amount is required for payment");
  }

  const customerExternalId = getCustomerExternalIdentifier(saved);
  const personId = getPersonId(saved);

  const payload = {
    Details: {
      Type: 1, // InvoiceAndReceipt
      Date: new Date().toISOString(),
      Original: true,
      IsDraft: false,

      Customer: {
        ExternalIdentifier: customerExternalId,
        CompanyNumber: personId,
        Name: saved.CustomerName || "Client",
        SearchMode: 2               // ExternalIdentifier
      }
    },

    Items: [{
    Quantity: 1,
    Item: {
      SKU: String(sku),
      SearchMode: 4,
      Description: "השגחה בטיפול פוריות"
      }
     }
    ],

    Payments: [
      {
        Amount: amount,
        Type: 5,
        Details_CreditCard: {
          Last4Digits: last4,
          Payments: payments
        }
      }
    ],

    VATIncluded: true,

    Credentials: {
      CompanyID: Number(process.env.SUMMIT_COMPANY_ID),
      APIKey: process.env.SUMMIT_API_KEY
    }
  };

  const res = await fetch(
    "https://app.sumit.co.il/accounting/documents/create/",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    }
  );

  const summit = unwrapSummit(await res.json());

  if (!summit.DocumentID) {
    throw new Error("Failed to create document");
  }

  return summit;
}

/* ---------------- API ENTRY ---------------- */

app.post("/summit", async (req, res) => {
  try {
    const {
      saved,
      amount,
      last4,
      payments = 1,
      sku
    } = req.body;

    const document = await createInvoiceAndReceipt({
      saved,
      amount,
      last4,
      payments,
      sku
    });

    res.json({
      ok: true,
      documentId: document.DocumentID,
      receiptUrl: document.DocumentDownloadURL
    });

  } catch (err) {
    console.error("Summit error:", err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

/* ---------------- SERVER ---------------- */

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
