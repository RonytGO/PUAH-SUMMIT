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
  if (!payments || isNaN(payments) || payments < 1) return 1;
  return payments;
}

function normalizePaymentMethod(method) {
  if (!method) return "credit";

  const m = String(method).trim();

  if (m === "כרטיס אשראי") return "credit";
  if (m === "מזומן") return "cash";
  if (m === "העברה בנקאית") return "bank";

  throw new Error("Unsupported payment method");
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

/* ---------------- CUSTOMER MANAGEMENT ---------------- */

async function searchCustomerByExternalId(externalId) {
  assertEnv();

  const payload = {
    Details: {
      ExternalIdentifier: externalId,
      SearchMode: 2
    },
    Credentials: {
      CompanyID: Number(process.env.SUMMIT_COMPANY_ID),
      APIKey: process.env.SUMMIT_API_KEY
    }
  };

  const res = await fetch(
    "https://app.sumit.co.il/customers/get/",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    }
  );

  const data = unwrapSummit(await res.json());
  return data;
}

async function createCustomer(saved) {
  assertEnv();

  const customer = {
    ExternalIdentifier: saved.customerexternalidentifier,
    Name: saved.CustomerName || "Client",
    Phone: saved.CustomerPhone || null,
    EmailAddress: saved.CustomerEmail || null,
    CompanyNumber: saved.personid || null
  };

  if (saved.CustomerCity) customer.City = saved.CustomerCity;
  if (saved.CustomerAddress) customer.Address = saved.CustomerAddress;

  const payload = {
    Details: customer,
    Credentials: {
      CompanyID: Number(process.env.SUMMIT_COMPANY_ID),
      APIKey: process.env.SUMMIT_API_KEY
    }
  };

  const res = await fetch(
    "https://app.sumit.co.il/customers/create/",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    }
  );

  unwrapSummit(await res.json());
}

async function updateCustomer(saved) {
  assertEnv();

  const properties = {};
  if (saved.CustomerCity) properties.City = saved.CustomerCity;
  if (saved.CustomerAddress) properties.Address = saved.CustomerAddress;

  if (Object.keys(properties).length === 0) return;

  const payload = {
    Details: {
      ExternalIdentifier: saved.customerexternalidentifier,
      SearchMode: 2,
      Properties: properties
    },
    Credentials: {
      CompanyID: Number(process.env.SUMMIT_COMPANY_ID),
      APIKey: process.env.SUMMIT_API_KEY
    }
  };

  const res = await fetch(
    "https://app.sumit.co.il/customers/update/",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    }
  );

  unwrapSummit(await res.json());
}

async function ensureCustomer(saved) {
  try {
    const existing = await searchCustomerByExternalId(saved.customerexternalidentifier);

    if (!existing || !existing.ID) {
      await createCustomer(saved);
    } else {
      await updateCustomer(saved);
    }
  } catch (err) {
    console.warn("Customer ensure warning:", err.message);
  }
}

/* ---------------- DOCUMENT CREATION ---------------- */

async function createInvoiceAndReceipt({
  saved,
  amount,
  last4,
  payments,
  sku,
  hospital,
  datecare,
  paymentMethod,
  bankNumber,
  branchNumber,
  accountNumber
}) {
  assertEnv();

  paymentMethod = normalizePaymentMethod(paymentMethod);
  payments = normalizePayments(payments);

  let paymentObject;

  if (paymentMethod === "cash") {
    paymentObject = { Amount: amount, Type: 2 };
  }

  if (paymentMethod === "credit") {
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

    paymentObject = {
      Amount: amount,
      Type: 5,
      Details_CreditCard: creditCardDetails
    };
  }

  if (paymentMethod === "bank") {
    paymentObject = {
      Amount: amount,
      Type: 3,
      Details_BankTransfer: {
        BankNumber: bankNumber ? Number(bankNumber) : null,
        BranchNumber: branchNumber ? Number(branchNumber) : null,
        AccountNumber: accountNumber ? String(accountNumber) : null
      }
    };
  }

  const itemDescription = `השגחה בטיפול פוריות ${hospital || ""}`;

  const payload = {
    Details: {
      Type: 1,
      Date: new Date().toISOString(),
      Original: true,
      IsDraft: false,
      Customer: {
        ExternalIdentifier: saved.customerexternalidentifier,
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
    Payments: [paymentObject],
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

  return unwrapSummit(await res.json());
}

/* ---------------- ROUTE ---------------- */

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
      datecare,
      paymentmethod,
      banknumber,
      branchnumber,
      accountnumber,
      city,
      address
    } = req.query;

    const normalizedAmount = normalizeAmount(amount);

    const saved = {
      customerexternalidentifier: familyid,
      personid,
      CustomerName: customername,
      CustomerPhone: customerphone,
      CustomerEmail: customeremail,
      CustomerCity: city,
      CustomerAddress: address
    };

    await ensureCustomer(saved);

    const document = await createInvoiceAndReceipt({
      saved,
      amount: normalizedAmount,
      last4,
      payments,
      sku,
      hospital,
      datecare,
      paymentMethod: paymentmethod,
      bankNumber: banknumber,
      branchNumber: branchnumber,
      accountNumber: accountnumber
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
