const express = require("express");

const app = express();
app.use(express.json());

/* ---------------- HELPERS ---------------- */

function normalizePhone(phone) {
  if (!phone) {
    throw new Error("CustomerPhone is required");
  }
  return phone.replace(/\D/g, "");
}

function assertEnv() {
  if (!process.env.SUMMIT_COMPANY_ID || !process.env.SUMMIT_API_KEY) {
    throw new Error("Missing Summit credentials in env variables");
  }
}

/* ---------------- SUMMIT RESPONSE HANDLER ---------------- */

function unwrapSummit(response) {
  if (!response || response.Status === undefined) {
    throw new Error("Invalid response from Summit");
  }

  // Success = 0
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
  regId,
  amount,
  last4,
  payments
}) {
  assertEnv();

  const phone = normalizePhone(saved.CustomerPhone);

  const payload = {
    Details: {
      Type: 1, // InvoiceAndReceipt
      Date: new Date().toISOString(),
      ExternalReference: regId,
      Original: true,

      Customer: {
        Name: saved.CustomerName || "Client",
        Phone: phone,
        ExternalIdentifier: phone,
        SearchMode: 2 // ExternalIdentifier
      }
    },

    Items: [
      {
        Quantity: 1,
        UnitPrice: amount,
        TotalPrice: amount,
        Item: { Name: "מוצר לדוגמה" }
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
    const saved = req.body.saved;
    const amount = req.body.amount;
    const regId = req.body.regId;
    const last4 = req.body.last4;
    const payments = req.body.payments || 1;

    const document = await createInvoiceAndReceipt({
      saved,
      regId,
      amount,
      last4,
      payments
    });

    res.json({
      ok: true,
      documentId: document.DocumentID,
      receiptUrl: document.DocumentDownloadURL
    });

  } catch (err) {
    console.error("Summit error:", err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

/* ---------------- SERVER ---------------- */

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
