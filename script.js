/* ====================================================================
   DMRC INTERN REFERRAL WIZARD — FRONTEND LOGIC
   ====================================================================
   This file is organised into six parts:
     1. Config & mock backend switch
     2. Application state (the single source of truth for the form)
     3. Ajax helpers (fetch wrappers -> real Django endpoints later)
     4. Step navigation & validation
     5. Feature logic: file uploads, capacity/waitlist, ticket stub
     6. Event wiring (runs once the DOM is ready)
   Every function has a comment explaining its job so this can be
   handed straight to whoever wires up the Django views.
==================================================================== */


/* ------------------------------------------------------------------
   1. CONFIG
   MOCK_MODE = true  -> no real server needed; fetch calls are
   intercepted and answered with fake JSON after a short delay, so
   you can open this file directly in a browser and click through
   the whole flow.
   MOCK_MODE = false -> calls hit the real API_BASE endpoints below.
   Flip this switch once the Django views exist; nothing else in
   this file needs to change if the response shapes match.
------------------------------------------------------------------- */
const MOCK_MODE = true;

const API_BASE = "/api/referrals"; // e.g. Django REST endpoints
const ENDPOINTS = {
  saveDraft:      `${API_BASE}/draft/`,        // POST -> upsert draft row
  checkCapacity:  `${API_BASE}/capacity/`,     // GET  -> {quota, filled, isWard}
  submit:         `${API_BASE}/submit/`,       // POST -> flips Draft -> Submitted, returns ticket code
};

// Mock department quotas, standing in for the real
// "Universal Quota Ceiling - Total Active Non-Ward Submissions" query
// described in Section 4.1 of the blueprint. max_capacity values below
// are copied straight from the cycle_department_capacities seed rows
// in Intern_Portal.sql (Summer 2026 / cycle_id 1 -- Winter mirrors it).
// `filled` is fabricated here just so the demo has something to show;
// the real number comes from a live COUNT() query on `applications`.
const MOCK_DEPARTMENT_QUOTAS = {
  "Civil":         { quota: 25, filled: 25 }, // full -> triggers waitlist
  "Mechanical/RS": { quota: 25, filled: 18 },
  "Electrical":    { quota: 40, filled: 22 },
  "IT":            { quota: 25, filled: 25 }, // full -> triggers waitlist
  "S&T":           { quota: 40, filled: 12 },
  "Finance":       { quota: 10, filled: 4 },
  "HR":            { quota: 5,  filled: 5 },  // full -> triggers waitlist
  "Legal":         { quota: 5,  filled: 2 },
};


/* ------------------------------------------------------------------
   2. APPLICATION STATE
   Everything the wizard knows about the in-progress application
   lives here. Steps read/write this object rather than reaching
   into each other's DOM, which keeps the ticket stub, the summary
   screen, and the save/submit payloads all in sync.
------------------------------------------------------------------- */
const state = {
  currentStep: 1,
  highestStepReached: 1,
  applicationCode: null,     // assigned by the server on first successful save
  status: "Draft",           // Draft | Waitlist-flagged | Submitted

  // Mirrors the `students` table columns, plus the academic_details
  // columns that travel with the candidate (university/college/degree/
  // branch/semester/percentages/cgpa).
  profile: {studentName: "",fathersName: "",gender: "",dob: "",studentPhone: "",studentEmail: "",permanentAddress: "",
    emergencyName: "",emergencyMobile: "",universityName: "",collegeName: "",degreeProgram: "",branchName: "",
    currentSemester: "",pct10: "", pct12: "", cgpa: ""
},

  // Keys here match document_types.type_name (slugified) so a future
  // FormData payload can loop over Object.entries(state.documents)
  // and post each file against the right doc_type_id.
  documents: {
    passport_photo:            null, // holds { file: File, renamedAs: string, valid: bool }
    signature:                 null,
    aadhar_card:                null,
    college_id:                null,
    letter_of_recommendation:  null,
  },

  // Mirrors `applications` (department_id/cycle_id/duration_weeks/is_ward)
  // -- session + applicationYear together resolve to a single cycle_id
  // on the backend (internship_cycles is keyed on session_term + year).
  placement: {
    department: "", session: "", applicationYear: "",
    duration: "4", doj: "", isWard: false,
  },

  capacity: null, // { quota, filled, isFull } for the selected department

  // applications.accepted_declarations is a single boolean column;
  // we keep three checkboxes in the UI for clarity, then collapse
  // them into one flag before the submit payload goes out.
  declarations: { d1: false, d2: false, d3: false },
};


/* ------------------------------------------------------------------
   3. AJAX HELPERS
   Thin wrapper around fetch() so every call gets the same error
   handling and, in mock mode, a simulated network round-trip.
   `payload` is a plain object; we JSON.stringify it here. File
   uploads would switch this to FormData in the real integration
   (left as a TODO comment below).
------------------------------------------------------------------- */
function mockResponse(data, delay = 500) {
  return new Promise((resolve) => setTimeout(() => resolve(data), delay));
}

async function postJSON(url, payload) {
  if (MOCK_MODE) {
    // --- MOCK BRANCH: fabricate a plausible server response ---
    if (url === ENDPOINTS.saveDraft) {
      if (!state.applicationCode) {
        // Simulate the server minting a ticket code on first save,
        // per Section 3's "Atomic Ticket Generation" logic.
        const seq = String(Math.floor(Math.random() * 900) + 100);
        state.applicationCode = `DMRC-2026S-${seq}`;
      }
      return mockResponse({ ok: true, applicationCode: state.applicationCode });
    }
    if (url === ENDPOINTS.submit) {
      const isWaitlist = state.capacity?.isFull && !state.placement.isWard;
      const code = isWaitlist
        ? state.applicationCode.replace(/(-\d+)$/, "-WL$1").replace("--", "-")
        : state.applicationCode;
      return mockResponse({ ok: true, applicationCode: code, status: "Submitted" }, 900);
    }
    return mockResponse({ ok: true });
  }

  // --- REAL BRANCH: talk to Django once the backend exists ---
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      // Django's CSRF middleware needs this header on unsafe methods;
      // read the token from the csrftoken cookie in production.
      "X-CSRFToken": getCsrfToken(),
    },
    body: JSON.stringify(payload),
  });
  if (!response.ok) throw new Error(`Request failed: ${response.status}`);
  return response.json();

  // TODO (backend integration): if payload includes File objects
  // (document uploads), build a FormData instance instead of JSON
  // and drop the "Content-Type" header so the browser sets the
  // correct multipart boundary automatically.
}

async function getJSON(url) {
  if (MOCK_MODE) {
    if (url.startsWith(ENDPOINTS.checkCapacity)) {
      const dept = new URL(url, window.location.origin).searchParams.get("department");
      const q = MOCK_DEPARTMENT_QUOTAS[dept] || { quota: 0, filled: 0 };
      return mockResponse({ quota: q.quota, filled: q.filled, isFull: q.filled >= q.quota }, 350);
    }
    return mockResponse({});
  }
  const response = await fetch(url, { headers: { "X-Requested-With": "XMLHttpRequest" } });
  if (!response.ok) throw new Error(`Request failed: ${response.status}`);
  return response.json();
}

function getCsrfToken() {
  // Standard Django pattern: CSRF token is stored in a cookie named
  // "csrftoken" once {% csrf_token %} / ensure_csrf_cookie has run.
  const match = document.cookie.match(/csrftoken=([^;]+)/);
  return match ? match[1] : "";
}


/* ------------------------------------------------------------------
   4. STEP NAVIGATION & VALIDATION
------------------------------------------------------------------- */
const totalSteps = 5;

function showStep(step) {
  document.querySelectorAll(".wizard-panel").forEach((panel) => {
    panel.classList.toggle("d-none", Number(panel.dataset.panel) !== step);
  });
  state.currentStep = step;
  renderStepper();
  renderActionBar();
  if (step === 5) renderSummary();
  window.scrollTo({ top: 0, behavior: "smooth" });
}

// Paints the stepper's active / complete / reachable states.
function renderStepper() {
  document.querySelectorAll(".step-item").forEach((item) => {
    const stepNum = Number(item.dataset.step);
    item.classList.toggle("is-active", stepNum === state.currentStep);
    item.classList.toggle("is-complete", stepNum < state.currentStep);
    item.classList.toggle("is-reachable", stepNum <= state.highestStepReached);
  });
}

// Shows/hides the Back / Next / Submit buttons for the current step.
function renderActionBar() {
  document.getElementById("btnBack").classList.toggle("d-none", state.currentStep === 1);
  document.getElementById("btnNext").classList.toggle("d-none", state.currentStep === totalSteps);
  document.getElementById("btnSubmit").classList.toggle("d-none", state.currentStep !== totalSteps);
}

// Runs Bootstrap's built-in validation styling (.was-validated) plus
// a couple of custom checks (file uploads, declarations) that HTML5
// `required` can't express on its own.
function validateStep(step) {
  if (step === 1) {
    const panel = document.getElementById("panel-1");
    panel.classList.add("was-validated");
    return panel.querySelectorAll(":invalid").length === 0;
  }
  if (step === 2) {
    const panel = document.getElementById("panel-2");
    panel.classList.add("was-validated");
    return panel.querySelectorAll(":invalid").length === 0;
  }
  if (step === 3) {
    const requiredDocs = Object.keys(state.documents); // all 5 are mandatory
    const allUploaded = requiredDocs.every((key) => state.documents[key] && state.documents[key].valid);
    if (!allUploaded) showToast("Please upload all five documents before continuing.", "danger");
    return allUploaded;
  }
  if (step === 4) {
    const panel = document.getElementById("panel-4");
    panel.classList.add("was-validated");
    return panel.querySelectorAll(":invalid").length === 0;
  }
  if (step === 5) {
    const allChecked = state.declarations.d1 && state.declarations.d2 && state.declarations.d3;
    if (!allChecked) showToast("All three declarations must be checked before submitting.", "danger");
    return allChecked;
  }
  return true;
}

// Pulls the current DOM values for the active step into `state`
// before we validate/save/navigate away from it.
function collectStepInputs(step) {
  if (step === 1) {
    // students table fields
    state.profile.studentName      = val("studentName");
    state.profile.fathersName      = val("fathersName");
    state.profile.gender           = val("gender");
    state.profile.dob              = val("dob");
    state.profile.studentPhone     = val("studentPhone");
    state.profile.studentEmail     = val("studentEmail");
    state.profile.permanentAddress = val("permanentAddress");
    state.profile.emergencyName    = val("emergencyName");
    state.profile.emergencyMobile  = val("emergencyMobile");
  }
  if( step ===2){
    // academic_details table fields
    state.profile.universityName   = val("universityName");
    state.profile.collegeName      = val("collegeName");
    state.profile.degreeProgram    = val("degreeProgram");
    state.profile.branchName       = val("branchName");
    state.profile.currentSemester  = val("currentSemester");
    state.profile.pct10 = val("pct10");
    state.profile.pct12 = val("pct12");
    state.profile.cgpa  = val("cgpa");
  }
  if (step === 4) {
    state.placement.department       = val("department");
    state.placement.session          = val("session");
    state.placement.applicationYear  = val("applicationYear");
    state.placement.duration         = val("duration");
    state.placement.doj              = val("doj");
    state.placement.isWard           = document.getElementById("wardCheckbox").checked;
  }
  if (step === 5) {
    state.declarations.d1 = document.getElementById("declare1").checked;
    state.declarations.d2 = document.getElementById("declare2").checked;
    state.declarations.d3 = document.getElementById("declare3").checked;
  }
}
const val = (id) => document.getElementById(id).value.trim();


/* ------------------------------------------------------------------
   5a. FILE UPLOAD HANDLING (Step 2)
   Client-side guardrails mirror Section 2's "Pre-Validation" rule:
   reject anything over 5MB or an unsupported extension, and rename
   accepted files to the ticket-style pattern before "upload".
------------------------------------------------------------------- */
const MAX_FILE_MB = 5;
const ALLOWED_EXT = ["pdf", "jpg", "jpeg", "png"];

function handleFileSelect(docType, file) {
  const statusEl = document.querySelector(`[data-status-for="${docType}"]`);
  const zoneEl   = document.querySelector(`.dropzone[data-doc-type="${docType}"]`);

  const ext = file.name.split(".").pop().toLowerCase();
  const tooBig = file.size > MAX_FILE_MB * 1024 * 1024;
  const badType = !ALLOWED_EXT.includes(ext);

  if (tooBig || badType) {
    state.documents[docType] = { file, valid: false };
    zoneEl.classList.remove("is-valid");
    zoneEl.classList.add("is-invalid");
    statusEl.innerHTML = `<span class="error-text">
      <i class="bi bi-exclamation-circle"></i>
      ${tooBig ? "File exceeds 5MB limit." : "Unsupported format."} Please upload a compressed PDF or image.
    </span>`;
    return;
  }

  // Passed pre-validation: build the standardized cloud filename.
  // Pattern from Section 2: {TicketCode}_{DocumentType}.{ext}
  const ticketFragment = state.applicationCode || "DRAFT-PENDING";
  const renamedAs = `${ticketFragment}_${docType}.${ext}`;

  state.documents[docType] = { file, valid: true, renamedAs };
  zoneEl.classList.remove("is-invalid");
  zoneEl.classList.add("is-valid");
  statusEl.innerHTML = `<span class="filename-pill">
      <i class="bi bi-check-circle-fill text-success"></i> ${renamedAs}
    </span>`;
}

function wireDropzones() {
  document.querySelectorAll(".dropzone").forEach((zone) => {
    const docType = zone.dataset.docType;
    const input = zone.querySelector(".dz-input");

    input.addEventListener("change", () => {
      if (input.files[0]) handleFileSelect(docType, input.files[0]);
    });

    // Basic drag-and-drop support layered on top of the native input.
    ["dragenter", "dragover"].forEach((evt) =>
      zone.addEventListener(evt, (e) => { e.preventDefault(); zone.classList.add("is-dragover"); })
    );
    ["dragleave", "drop"].forEach((evt) =>
      zone.addEventListener(evt, (e) => { e.preventDefault(); zone.classList.remove("is-dragover"); })
    );
    zone.addEventListener("drop", (e) => {
      const file = e.dataTransfer.files[0];
      if (file) { input.files = e.dataTransfer.files; handleFileSelect(docType, file); }
    });
  });
}


/* ------------------------------------------------------------------
   5b. CAPACITY / WAITLIST LOGIC (Step 3)
   Mirrors Section 4.1: never show a negative counter, flip to a
   "Waitlist" label when full, and suppress the caution message
   entirely for verified Wards.
------------------------------------------------------------------- */
async function refreshCapacity() {
  const dept = document.getElementById("department").value;
  const readout = document.getElementById("capacityReadout");
  const banner = document.getElementById("waitlistBanner");

  if (!dept) { readout.innerHTML = ""; banner.classList.add("d-none"); return; }

  readout.innerHTML = `<span class="text-secondary">Checking availability...</span>`;
  const data = await getJSON(`${ENDPOINTS.checkCapacity}?department=${dept}`);
  state.capacity = data;

  const isWard = document.getElementById("wardCheckbox").checked;

  if (!data.isFull) {
    const remaining = data.quota - data.filled;
    readout.innerHTML = `<span class="cap-ok"><i class="bi bi-check-circle"></i> ${remaining} of ${data.quota} slots open</span>`;
    banner.classList.add("d-none");
  } else {
    readout.innerHTML = `<span class="cap-full"><i class="bi bi-hourglass-split"></i> Availability: Waitlist</span>`;
    // Ward Checkbox Exception: caution banner only shows for non-Wards.
    banner.classList.toggle("d-none", isWard);
  }

  updateTicketStub();
}


/* ------------------------------------------------------------------
   5c. TICKET STUB (live summary card)
------------------------------------------------------------------- */
function updateTicketStub() {
  document.getElementById("ticketCode").textContent =
    state.applicationCode ? `#${state.applicationCode}` : "DRAFT · NOT ISSUED";
  document.getElementById("ticketName").textContent = state.profile.studentName || "—";
  document.getElementById("ticketCollege").textContent = state.profile.collegeName || "—";
  document.getElementById("ticketDept").textContent = state.placement.department || "—";
  document.getElementById("ticketSession").textContent =
    state.placement.session ? `${state.placement.session} ${state.placement.applicationYear || ""}`.trim() : "—";
  document.getElementById("ticketDoj").textContent = state.placement.doj || "—";

  const pill = document.getElementById("ticketStatusPill");
  const isWaitlist = state.capacity?.isFull && !state.placement.isWard;

  if (state.status === "Submitted") {
    pill.textContent = "Submitted"; pill.className = "status-pill status-submitted";
  } else if (isWaitlist) {
    pill.textContent = "Waitlist Risk"; pill.className = "status-pill status-waitlist";
  } else if (state.highestStepReached >= 3) {
    pill.textContent = "Ready"; pill.className = "status-pill status-ready";
  } else {
    pill.textContent = "Draft"; pill.className = "status-pill status-draft";
  }
}

// Builds the read-only recap shown on Step 5.
function renderSummary() {
  const docCount = Object.values(state.documents).filter((d) => d?.valid).length;
  const totalDocs = Object.keys(state.documents).length;
  const items = [
    ["Candidate", state.profile.studentName],
    ["Father's Name", state.profile.fathersName],
    ["Gender", state.profile.gender],
    ["Mobile", state.profile.studentPhone],
    ["Email", state.profile.studentEmail],
    ["University", state.profile.universityName],
    ["College", state.profile.collegeName],
    ["Degree / Branch", `${state.profile.degreeProgram} - ${state.profile.branchName}`],
    ["Current Semester", state.profile.currentSemester],
    ["10th % / 12th %", `${state.profile.pct10 || "—"}% / ${state.profile.pct12 || "—"}%`],
    ["Current CGPA", state.profile.cgpa],
    ["Department", state.placement.department],
    ["Session", `${state.placement.session} ${state.placement.applicationYear}`],
    ["Duration", `${state.placement.duration} weeks`],
    ["Date of Joining", state.placement.doj],
    ["Ward Applicant", state.placement.isWard ? "Yes" : "No"],
    ["Documents", `${docCount} / ${totalDocs} uploaded`],
  ];
  document.getElementById("summaryGrid").innerHTML = items
    .map(([label, value]) => `
      <div class="sg-item">
        <dt>${label}</dt>
        <dd>${value || "—"}</dd>
      </div>`).join("");
}


/* ------------------------------------------------------------------
   5d. TOASTS
------------------------------------------------------------------- */
function showToast(message, variant = "primary") {
  const wrap = document.createElement("div");
  wrap.className = `toast align-items-center text-bg-${variant} border-0`;
  wrap.setAttribute("role", "alert");
  wrap.innerHTML = `
    <div class="d-flex">
      <div class="toast-body">${message}</div>
      <button type="button" class="btn-close btn-close-white me-2 m-auto" data-bs-dismiss="toast"></button>
    </div>`;
  document.getElementById("toastContainer").appendChild(wrap);
  const toast = new bootstrap.Toast(wrap, { delay: 3200 });
  toast.show();
  wrap.addEventListener("hidden.bs.toast", () => wrap.remove());
}


/* ------------------------------------------------------------------
   5e. SAVE DRAFT / SUBMIT (the two real Ajax actions)
------------------------------------------------------------------- */
async function saveDraft(silent = false) {
  collectStepInputs(state.currentStep);
  try {
    const result = await postJSON(ENDPOINTS.saveDraft, {
      applicationCode: state.applicationCode,
      profile: state.profile,
      placement: state.placement,
      // documents are uploaded as FormData in the real integration;
      // here we only send which slots are filled.
      documentsPresent: Object.keys(state.documents).filter((k) => state.documents[k]?.valid),
    });
    state.applicationCode = result.applicationCode;
    document.getElementById("lastSavedAt").textContent = new Date().toLocaleTimeString();
    updateTicketStub();
    if (!silent) showToast("Draft saved.", "success");
  } catch (err) {
    showToast("Could not save draft. Check your connection and try again.", "danger");
    console.error(err);
  }
}

async function submitApplication() {
  collectStepInputs(5);
  if (!validateStep(5)) return;

  try {
    const result = await postJSON(ENDPOINTS.submit, {
      applicationCode: state.applicationCode,
      profile: state.profile,
      placement: state.placement,
      // applications.accepted_declarations is a single BOOLEAN column;
      // true only once all three on-screen checkboxes are ticked.
      accepted_declarations: state.declarations.d1 && state.declarations.d2 && state.declarations.d3,
    });
    state.status = "Submitted";
    state.applicationCode = result.applicationCode;
    updateTicketStub();

    document.getElementById("finalTicketCode").textContent = `#${result.applicationCode}`;
    new bootstrap.Modal(document.getElementById("successModal")).show();
  } catch (err) {
    showToast("Submission failed. Your draft is safe — please try again.", "danger");
    console.error(err);
  }
}


/* ------------------------------------------------------------------
   6. EVENT WIRING
------------------------------------------------------------------- */
document.addEventListener("DOMContentLoaded", () => {
  wireDropzones();
  showStep(1);
  updateTicketStub();

  // Stepper: clicking a step you've already reached jumps straight there.
  document.querySelectorAll(".step-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      const target = Number(btn.dataset.goto);
      if (target <= state.highestStepReached) showStep(target);
    });
  });

  // Next / Save & Next
  document.getElementById("btnNext").addEventListener("click", async () => {
    collectStepInputs(state.currentStep);
    if (!validateStep(state.currentStep)) return;
    await saveDraft(true);
    const next = Math.min(state.currentStep + 1, totalSteps);
    state.highestStepReached = Math.max(state.highestStepReached, next);
    showStep(next);
  });

  // Back / Save & Back
  document.getElementById("btnBack").addEventListener("click", async () => {
    collectStepInputs(state.currentStep);
    await saveDraft(true);
    showStep(Math.max(state.currentStep - 1, 1));
  });

  // Explicit "Save Draft" button, usable from any step.
  document.getElementById("btnSaveDraft").addEventListener("click", () => saveDraft(false));

  // Preview & Submit
  document.getElementById("btnSubmit").addEventListener("click", submitApplication);

  // Step 3: department change re-checks capacity; ward toggle
  // re-evaluates whether the caution banner should show.
  document.getElementById("department").addEventListener("change", refreshCapacity);
  document.getElementById("wardCheckbox").addEventListener("change", refreshCapacity);

  // Declarations feed straight into state so Step 4's submit gate
  // can validate without re-reading the DOM.
  ["declare1", "declare2", "declare3"].forEach((id, idx) => {
    document.getElementById(id).addEventListener("change", (e) => {
      state.declarations[`d${idx + 1}`] = e.target.checked;
    });
  });

  // Keep the ticket stub live as the referrer types the name/college.
  ["studentName", "collegeName"].forEach((id) => {
    document.getElementById(id).addEventListener("input", () => {
      state.profile.studentName = val("studentName");
      state.profile.collegeName = val("collegeName");
      updateTicketStub();
    });
  });
});
