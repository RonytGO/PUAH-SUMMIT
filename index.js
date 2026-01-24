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
  if (!response || !response.Status) {
    throw new Error("Invalid response from Summit");
  }

  if (response.Status !== "Success") {
    throw new Error(
      response.UserErrorMessage ||
      response.TechnicalErrorDetails ||
      "Summit returned an error"
    );
  }

  return response.Data || {};
}

/* ---------------- SUMMIT: CUSTOMER ---------------- */

async function createOrGetCustomer(saved) {
  assertEnv();

  const payload = {
    Details: {
      ExternalIdentifier: normalizePhone(saved.CustomerPhone),
      Name: saved.CustomerName || "Client"
    },
    Credentials: {
      CompanyID: Number(process.env.SUMMIT_COMPANY_ID),
      APIKey: process.env.SUMMIT_API_KEY
    }
  };

  const res = await fetch(
    "https://api.sumit.co.il/accounting/customers/create/",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    }
  );

const rawText = await res.text();
console.log("SUMMIT RAW RESPONSE:", rawText);

let parsed;
try {
  parsed = JSON.parse(rawText);
} catch (e) {
  console.error("SUMMIT RESPONSE IS NOT JSON");
  throw new Error("Invalid response from Summit");
}

const summit = unwrapSummit(parsed);

  //const summit = unwrapSummit(await res.json());

  if (!summit.CustomerID) {
    throw new Error("Failed to create or fetch customer");
  }

  return summit.CustomerID;
}

/* ---------------- SUMMIT: DOCUMENT ---------------- */

async function createInvoiceAndReceipt({
  customerId,
  regId,
  amount,
  last4,
  payments
}) {
  assertEnv();

  const payload = {
    Details: {
      Type: 1, // InvoiceAndReceipt
      Date: new Date().toISOString(),
      CustomerID: customerId,
      ExternalReference: regId,
      Original: true
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

    const customerId = await createOrGetCustomer(saved);

    const document = await createInvoiceAndReceipt({
      customerId,
      regId,
      amount,
      last4,
      payments
    });

    res.json({
      ok: true,
      customerId,
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
