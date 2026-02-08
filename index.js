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
  return String(saved.personid);
}

function normalizeAmount(rawAmount) {
  if (rawAmount === undefined || rawAmount === null || rawAmount === "") {
    throw new Error("amount is required");
  }

  const cleaned = String(rawAmount).replace(/[^\d.]/g, "");
  const amount = Number(cleaned);

  if (!amount || isNaN(amount) || amount <= 0) {
    throw new Error("amount is invalid");
  }

  return amount;
}

function normalizePayments(rawPayments) {
  const payments = Number(rawPayments);

  if (!payments || isNaN(payments) || payments < 1) {
    return 1;
  }

  return payments;
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
  sku,
  hospital,
  datecare
}) {
  assertEnv();

  if (!sku) throw new Error("SKU Item is required");
  if (amount === undefined || isNaN(amount) || amount <= 0) {
    throw new Error("amount is invalid");
  }

  /* ---------- CARE DATE ---------- */

  let careDate;

  if (datecare) {
    careDate = new Date(datecare);
  } else {
    careDate = new Date();
  }

  if (isNaN(careDate.getTime())) {
    throw new Error("Invalid datecare value");
  }

  const formattedDate = careDate.toLocaleDateString("he-IL");
  const itemDescription = `השגחה בטיפול פוריות ${formattedDate} ${hospital || ""}`.trim();

  const customerExternalId = getCustomerExternalIdentifier(saved);
  const personId = getPersonId(saved);

  const customerNameNormalized =
    saved.CustomerName && saved.CustomerName.trim() !== ""
      ? saved.CustomerName.trim()
      : "Client";

  /* ---------- CREDIT CARD DETAILS ---------- */

  payments = normalizePayments(payments);

  const creditCardDetails = {
    Last4Digits: last4 ? String(last4) : null,
    Payments: payments
  };

  if (payments === 1) {
    creditCardDetails.FirstPayment = amount;
  } else {
    const installment = amount / payments;
    creditCardDetails.FirstPayment = installment;
    creditCardDetails.EachPayment = installment;
  }

  /* ---------- PAYLOAD ---------- */

  const payload = {
    Details: {
      Type: 1,
      Date: new Date().toISOString(),
      Original: true,
      IsDraft: false,
      Customer: {
        ExternalIdentifier: customerExternalId,
        CompanyNumber: personId,
        Name: customerNameNormalized,
        Phone: saved.CustomerPhone || null,
        EmailAddress: saved.CustomerEmail || null,
        SearchMode: 2
      }
    },

    Items: [
      {
        Quantity: 1,
        UnitPrice: amount,
        TotalPrice: amount,
        Description: itemDescription,
        Item: {
          ExternalIdentifier: String(sku),
          SearchMode: 2
        }
      }
    ],

    Payments: [
      {
        Amount: amount,
        Type: 5,
        Details_CreditCard: creditCardDetails
      }
    ],

    VATIncluded: true,

    Credentials: {
      CompanyID: Number(process.env.SUMMIT_COMPANY_ID),
      APIKey: process.env.SUMMIT_API_KEY
    }
  };

  const response = await fetch(
    "https://app.sumit.co.il/accounting/documents/create/",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    }
  );

  const summit = unwrapSummit(await response.json());

  if (!summit.DocumentID) {
    throw new Error("Failed to create document");
  }

  return summit;
}

/* ---------------- API ENTRY (POST) ---------------- */

app.post("/summit", async (req, res) => {
  try {
    const {
      saved,
      amount,
      last4,
      payments,
      sku,
      hospital,
      datecare
    } = req.body;

    const normalizedAmount = normalizeAmount(amount);
    const normalizedPayments = normalizePayments(payments);

    const document = await createInvoiceAndReceipt({
      saved,
      amount: normalizedAmount,
      last4,
      payments: normalizedPayments,
      sku,
      hospital,
      datecare
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

/* ---------------- SALESFORCE BUTTON (GET + REDIRECT) ---------------- */

app.get("/summit-from-sf", async (req, res) => {
  try {
    const {
      paymentId,
      familyid,
      personid,
      customername,
      customerphone,
      customeremail,
      amount,
      hospital,
      sku,
      last4,
      payments,
      datecare
    } = req.query;

    if (!paymentId) throw new Error("paymentId is required");
    if (!familyid) throw new Error("familyid is required");
    if (!personid) throw new Error("personid is required");
    if (!amount) throw new Error("amount is required");
    if (!hospital) throw new Error("hospital is required");
    if (!sku) throw new Error("sku is required");

    const normalizedAmount = normalizeAmount(amount);
    const normalizedPayments = normalizePayments(payments);

    const saved = {
      customerexternalidentifier: familyid,
      personid: personid,
      CustomerName: customername,
      CustomerPhone: customerphone || null,
      CustomerEmail: customeremail || null
    };

    const document = await createInvoiceAndReceipt({
      saved,
      amount: normalizedAmount,
      last4: last4 || null,
      payments: normalizedPayments,
      sku,
      hospital,
      datecare
    });

    res.redirect(
      `https://puah.lightning.force.com/flow/SaveReceipt` +
      `?recordId=${paymentId}` +
      `&receiptUrl=${encodeURIComponent(document.DocumentDownloadURL)}`
    );

  } catch (err) {
    console.error("SF GET Summit error:", err.message);
    res.status(500).send(err.message);
  }
});

/* ---------------- SERVER ---------------- */

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
