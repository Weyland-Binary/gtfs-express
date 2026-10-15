/**
 * useContract — the project's contract as both flows hold it (the Network
 * Studio, the Change Studio): read from the project (a
 * draft of its own when the flow runs without one), written back through
 * the flow's `onUpdateProject` (the server keeps it with the project),
 * with the name of the person who decides (the account's, else the one this
 * browser remembers: never a decision without a name) and, at ②, the
 * coverage of the brief by the contract as the server's detector reports it
 * (G5, POST /contract/coverage, debounced; never computed here).
 *
 *   const c = useContract({ project, onUpdateProject, job, active, documents })
 *   c.contract · c.setContract(next | fn) · c.ready · c.name · c.setName
 *   c.brief · c.setBrief(text): the brief typed or pasted at ② (not a document), kept WITH the contract
 *     (contract.brief): the server reads it on every measure — the coverage at ②, the previews, the evaluation,
 *     the dry run and the build — and it survives a reload
 *   c.coverage · c.coverageState · c.proceed("decided" | "assumed" | "empty") → the contract recorded under the
 *     decider's name (an empty one too), or null when no valid name is typed (nothing recorded);
 *     proceed(status | (contract) => status, who, { prepare }) — `prepare(contract)`: what the same act does to the
 *     contract first (②'s one act keeps every objective proposed: utils/contract.acceptAll), in one write
 *   c.recordEmpty(name?) → the contract recorded empty under that name (the acknowledgement form's at the build
 *     or the application, when ② was left undecided), or null without a valid name — never an unnamed empty contract
 *   c.fromExtraction(draft) (the planners' `contract` event over what ② holds)
 *   c.offer · c.setOffer(o | fn): the offer sheets of the brief (their file names, aggregates and the
 *     build_timetable operations they give), kept with the project (context.offer) for ③ of the modify job;
 *     a function receives the offer held (several sheets read at once each add to the others')
 *
 * A modify project starts with the two « inchangé » clauses, kept by default
 * (prefilled once: `prefilled`, so a person who waives them is never asked
 * again).
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useLanguage } from "../../contexts/LanguageContext";
import { useAccount } from "../../contexts/AccountContext";
import { withJournal } from "../../utils/projectStore";
import { fetchContractCoverage } from "../../utils/networkStudioApi";
import { boundedContract, emptyContract, finalize, isReady, nameOk, unchangedClauses, waiveRecord, waiversAdded, withExtraction } from "../../utils/contract";
import { rememberName, rememberedName } from "./AcknowledgementForm";

const COVERAGE_MS = 600;
const DOCUMENT_ID = /^[a-f0-9]{24}$/;

export default function useContract({ project = null, onUpdateProject = null, job = "create", active = false, documents = [] } = {}) {
  const { t } = useLanguage();
  const { me } = useAccount();
  const [local, setLocal] = useState(emptyContract);
  const contract = project?.contract ? { ...emptyContract(), ...project.contract } : local;
  const contractRef = useRef(contract);
  contractRef.current = contract;
  const [name, setNameState] = useState(() => rememberedName() || me?.display_name || "");
  const setName = useCallback((value) => {
    setNameState(value);
    if (nameOk(value)) rememberName(value.trim());
  }, []);
  useEffect(() => {
    if (!name && me?.display_name) setNameState(me.display_name);
  }, [me?.display_name]); // eslint-disable-line react-hooks/exhaustive-deps

  const setContract = useCallback(
    (next, journal = null) => {
      // Held within the server's bounds, what is left out said by a wish (utils/contract.boundedContract).
      const compute = (prev) => boundedContract(typeof next === "function" ? next({ ...emptyContract(), ...(prev || {}) }) : next, (count, max, what) => t(what === "wishes" ? "contract.overflowWishes" : "contract.overflow", { count, max }));
      if (project && onUpdateProject)
        onUpdateProject((p) => {
          const contract = compute(p.contract);
          // A clause written off at ② is an acceptance of scope waive: recorded with the project, journaled under its name.
          const waived = waiversAdded(p.contract, contract);
          let out = { ...p, contract, ...(waived.length ? { acknowledgements: [...(p.acknowledgements || []), ...waived.map((c) => waiveRecord(c))] } : {}) };
          for (const c of waived) out = withJournal(out, { actor: c.decision.by.name, action: "waive", object: c.id, reason: c.decision.reason || null });
          return journal ? withJournal(out, journal) : out;
        });
      else setLocal((prev) => compute(prev));
    },
    [project, onUpdateProject, t],
  );

  // A modify project starts with the two « inchangé » clauses, kept by default (once).
  const prefill = job === "modify" && contract.status === "draft" && !contract.prefilled;
  useEffect(() => {
    if (!prefill) return;
    setContract((c) => (c.prefilled || c.status !== "draft" ? c : { ...c, prefilled: true, clauses: [...unchangedClauses(t).filter((u) => !(c.clauses || []).some((x) => x.id === u.id)), ...(c.clauses || [])] }));
  }, [prefill]); // eslint-disable-line react-hooks/exhaustive-deps

  const documentIds = useMemo(() => [...new Set([...(documents || []), ...(project?.documents || []).map((d) => d.id)].filter((id) => typeof id === "string" && DOCUMENT_ID.test(id)))], [documents, project?.documents]);

  // G5 at ②: the server's detector on the brief and the documents, the contract as it stands (debounced).
  const [coverage, setCoverage] = useState(null);
  const [coverageState, setCoverageState] = useState(null);
  const brief = typeof contract.brief === "string" ? contract.brief : "";
  const setBrief = useCallback((text) => setContract((c) => ({ ...c, brief: String(text ?? "") })), [setContract]);
  const coverageKey = JSON.stringify({ c: contract.clauses?.map((c) => [c.id, c.quote]), w: contract.wishes?.map((w) => w.quote), d: contract.dismissed?.map((x) => x.sentence), n: contract.extracted?.note || "", s: contract.status, documentIds, brief });
  useEffect(() => {
    if (!active) return undefined;
    const hasText = documentIds.length || brief.trim() || String(contract.extracted?.note || "").trim();
    if (!hasText) {
      // Nothing to measure (the field emptied before its measure left): no measure is « running » any more.
      setCoverage(null);
      setCoverageState(null);
      return undefined;
    }
    let live = true;
    setCoverageState("loading");
    const timer = setTimeout(() => {
      fetchContractCoverage({ contract: contractRef.current, documents: documentIds })
        .then((r) => {
          if (!live) return;
          setCoverage(r.coverage || null);
          setCoverageState(null);
        })
        .catch(() => live && setCoverageState("error"));
    }, COVERAGE_MS);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [active, coverageKey]); // eslint-disable-line react-hooks/exhaustive-deps

  // The contract recorded under the decider's name — an empty one too (never anonymous). Without a valid
  // name nothing is recorded (null): the panel's primary action is off then (proceedState "contract.nameRequired").
  // `who`: the name the person just gave (② asks it at the moment of the act), before the state holds it.
  const proceed = useCallback(
    (status, who = name, { prepare = null } = {}) => {
      if (!nameOk(who)) return null;
      const base = prepare ? prepare(contractRef.current) : contractRef.current;
      const kind = typeof status === "function" ? status(base) : status;
      const next = finalize(base, kind, { name: who });
      setContract(next, { actor: who.trim(), action: "contract", object: kind });
      return next;
    },
    [name, setContract],
  );
  // ② left undecided and the person names themself where they build or apply: the contract is recorded empty under
  // that name (the build never records it by itself, nor anonymously). A draft only.
  const recordEmpty = useCallback(
    (who = name) => {
      if (!nameOk(who) || (contractRef.current?.status && contractRef.current.status !== "draft")) return null;
      const next = finalize(contractRef.current, "empty", { name: who });
      setContract(next, { actor: who.trim(), action: "contract", object: "empty" });
      return next;
    },
    [name, setContract],
  );
  const fromExtraction = useCallback((draft) => setContract((c) => withExtraction(c, draft), { actor: null, action: "contract", object: "extracted" }), [setContract]);

  // The offer sheet imported at ②: with the project (its context), else held here for this flow.
  const [localOffer, setLocalOffer] = useState(null);
  const offer = project ? project.context?.offer || null : localOffer;
  // `next`: the offer, or a function of the one held (two sheets read at once each add to the other's, never over it).
  const setOffer = useCallback(
    (next) => {
      const compute = (prev) => (typeof next === "function" ? next(prev || null) : next);
      if (project && onUpdateProject)
        onUpdateProject((p) => {
          const offer = compute(p.context?.offer || null);
          return withJournal({ ...p, context: { ...(p.context || {}), offer } }, { actor: null, action: "offer_sheet", object: offer?.name || null });
        });
      else setLocalOffer((prev) => compute(prev));
    },
    [project, onUpdateProject],
  );

  return { contract, setContract, ready: isReady(contract), name, setName, brief, setBrief, coverage, coverageState, proceed, recordEmpty, fromExtraction, documentIds, offer, setOffer };
}
