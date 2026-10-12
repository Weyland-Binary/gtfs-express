/**
 * projects/deliverables.js — what a project hands over, always built from an
 * APPROVED version (never a draft), in the project's language:
 *
 *   gtfs        the version's GTFS as a zip, DELIVERED ONLY VALIDATED (G1):
 *               the version's report comes from the controller's
 *               ctx.validateVersion() (validatorGate: a missing or crashed
 *               validator refuses with 503, never "unavailable"), and the
 *               baseline is the reference version's report — a new error
 *               above it refuses (409 VALIDATION_NEW_ERRORS), and without a
 *               reference the feed must carry no error at all (409
 *               VALIDATION_ERRORS). No zip is written on a refusal.
 *   synthesis   the synthesis note (.docx, or .md): the project, then the
 *               ENGINE'S VERDICT FIRST (G3/G4: the contract clause by
 *               clause with who acknowledged each unmet must clause and
 *               when, the GTFS validation line), the reference's figures,
 *               the contract with the brief's words, the scenarios
 *               compared, the approved one, the decisions with their
 *               acknowledgements, the assumptions, the open comments
 *   annex       the technical annex (.docx, or .md): the verdict block, the
 *               approved plan's operations with the brief's words, what the
 *               engine did at each step, the contract, the figures
 *   comparison  the scenarios side by side (.csv)
 *
 * The documents print what the engine measured and what the team decided,
 * never the assistant's prose. Every figure carries its basis (measured /
 * estimated / assumption), as on screen. build(kind, ctx) → { path, format,
 * validation? }.
 */

"use strict";

const fs = require("fs");
const path = require("path");
const files = require("./projectFiles");
const measures = require("./projectMeasures");
const { toDocx, toMarkdown } = require("./docx");

const LABELS = {
  en: { from_coherence: "from the coherence report of {version} of {date}", role_reader: "reader", role_contributor: "contributor", role_approver: "approver", synthesis: "Synthesis note", annex: "Technical annex", comparison: "Scenario comparison", project: "Project", client: "Client", territory: "Territory", context: "Context", prepared: "Prepared on", version: "Approved version", reference: "Reference", figures: "Key figures", figure: "Figure", before: "Reference", after: "Approved scenario", basis: "Basis", measured: "measured", estimated: "estimated", assumption: "assumption", lines: "Lines", trips: "Trips", fleet: "Vehicles at peak", veh_km: "Vehicle-km per year", veh_h: "Vehicle-hours per year", cost: "Operating cost per year", quality: "Network quality score", objectives: "The contract (objectives)", objective: "Objective", level: "Level", status: "Status", verdict: "Verdict", quote: "The brief's words", measured_as: "Measured", pass: "met", fail: "not met", unknown: "not measurable", scenarios: "Scenarios compared", scenario: "Scenario", must: "Must met", should: "Should met", approved_scenario: "The approved scenario", approved: "approved", decisions: "Decisions", date: "Date", who: "By", action: "Action", comment: "Comment", comments: "Open comments", operations: "Operations of the plan", operation: "Operation", step: "What the engine did", validation: "Validation of the GTFS", assumptions: "Assumptions", cost_note: "Costs are computed with {cpk} {cur} per km, the default, for want of the contract's unit costs: set them in the project to make them measured.", no_objective: "No objective was validated.", none: "None.", adjusted: "The approved scenario was adjusted on the map: its figures are measured on the adjusted feed.", tender: "Tender", amendment: "Contract amendment", study: "Study", other: "Other", validated: "validated", corrected: "corrected", waived: "waived", proposed: "proposed", draft: "draft", in_review: "in review", rejected: "rejected", submit: "submitted", approve: "approved", reject: "rejected", reopen: "reopened", verdict_block: "Verdict of the engine", acknowledged_by: "Acknowledged by", accepted_as: "accepted as not met", not_acknowledged: "not acknowledged", gtfs_validation_line: "GTFS validation: {status}, {errors} error(s), {preexisting} already in the reference ({engine}).", not_deliverable: "This version does not meet every mandatory clause: it was approved with the acknowledgements listed above.", not_checked: "not checked yet", valid: "valid", valid_with_preexisting: "valid, pre-existing errors kept", acknowledged: "Acknowledged" },
  fr: { from_coherence: "d'après le rapport de cohérence de {version} du {date}", role_reader: "lecteur", role_contributor: "contributeur", role_approver: "valideur", synthesis: "Note de synthèse", annex: "Annexe technique", comparison: "Comparaison des scénarios", project: "Projet", client: "Client", territory: "Territoire", context: "Contexte", prepared: "Établie le", version: "Version approuvée", reference: "Référence", figures: "Chiffres clés", figure: "Indicateur", before: "Référence", after: "Scénario approuvé", basis: "Base", measured: "mesuré", estimated: "estimé", assumption: "hypothèse", lines: "Lignes", trips: "Courses", fleet: "Véhicules en pointe", veh_km: "Véhicules-km par an", veh_h: "Heures de conduite par an", cost: "Coût d'exploitation annuel", quality: "Note de qualité du réseau", objectives: "Le contrat (objectifs)", objective: "Objectif", level: "Niveau", status: "Statut", verdict: "Verdict", quote: "Les mots du cahier des charges", measured_as: "Mesuré", pass: "tenu", fail: "non tenu", unknown: "non mesurable", scenarios: "Scénarios comparés", scenario: "Scénario", must: "Impératifs tenus", should: "Souhaits tenus", approved_scenario: "Le scénario approuvé", approved: "approuvé", decisions: "Décisions", date: "Date", who: "Par", action: "Action", comment: "Commentaire", comments: "Commentaires ouverts", operations: "Opérations du plan", operation: "Opération", step: "Ce que le moteur a fait", validation: "Validation du GTFS", assumptions: "Hypothèses", cost_note: "Coûts calculés avec {cpk} {cur} par km, la valeur par défaut, faute des coûts unitaires du contrat : renseignez-les dans le projet pour qu'ils soient mesurés.", no_objective: "Aucun objectif n'a été validé.", none: "Aucun.", adjusted: "Le scénario approuvé a été ajusté sur la carte : ses chiffres sont mesurés sur le flux ajusté.", tender: "Appel d'offres", amendment: "Avenant", study: "Étude", other: "Autre", validated: "validé", corrected: "corrigé", waived: "écarté", proposed: "proposé", draft: "brouillon", in_review: "en relecture", rejected: "refusé", submit: "soumis", approve: "approuvé", reject: "refusé", reopen: "rouvert", verdict_block: "Verdict du moteur", acknowledged_by: "Accepté par", accepted_as: "accepté comme non tenu", not_acknowledged: "non accepté", gtfs_validation_line: "Validation du GTFS : {status}, {errors} erreur(s), {preexisting} déjà dans la référence ({engine}).", not_deliverable: "Cette version ne tient pas toutes les clauses impératives : elle a été approuvée avec les acceptations listées ci-dessus.", not_checked: "pas encore vérifié", valid: "valide", valid_with_preexisting: "valide, erreurs préexistantes conservées", acknowledged: "Accepté" },
  es: { from_coherence: "según el informe de coherencia de {version} del {date}", role_reader: "lector", role_contributor: "colaborador", role_approver: "aprobador", synthesis: "Nota de síntesis", annex: "Anexo técnico", comparison: "Comparación de escenarios", project: "Proyecto", client: "Cliente", territory: "Territorio", context: "Contexto", prepared: "Elaborada el", version: "Versión aprobada", reference: "Referencia", figures: "Cifras clave", figure: "Indicador", before: "Referencia", after: "Escenario aprobado", basis: "Base", measured: "medido", estimated: "estimado", assumption: "hipótesis", lines: "Líneas", trips: "Viajes", fleet: "Vehículos en punta", veh_km: "Vehículos-km al año", veh_h: "Horas de servicio al año", cost: "Coste de explotación anual", quality: "Nota de calidad de la red", objectives: "El contrato (objetivos)", objective: "Objetivo", level: "Nivel", status: "Estado", verdict: "Veredicto", quote: "Las palabras del pliego", measured_as: "Medido", pass: "cumplido", fail: "no cumplido", unknown: "no medible", scenarios: "Escenarios comparados", scenario: "Escenario", must: "Obligatorios cumplidos", should: "Deseables cumplidos", approved_scenario: "El escenario aprobado", approved: "aprobado", decisions: "Decisiones", date: "Fecha", who: "Por", action: "Acción", comment: "Comentario", comments: "Comentarios abiertos", operations: "Operaciones del plan", operation: "Operación", step: "Lo que hizo el motor", validation: "Validación del GTFS", assumptions: "Hipótesis", cost_note: "Costes calculados con {cpk} {cur} por km, el valor por defecto, a falta de los costes unitarios del contrato: indíquelos en el proyecto para que sean medidos.", no_objective: "No se validó ningún objetivo.", none: "Ninguno.", adjusted: "El escenario aprobado se ajustó en el mapa: sus cifras se miden sobre el feed ajustado.", tender: "Licitación", amendment: "Modificación de contrato", study: "Estudio", other: "Otro", validated: "validado", corrected: "corregido", waived: "descartado", proposed: "propuesto", draft: "borrador", in_review: "en revisión", rejected: "rechazado", submit: "enviado", approve: "aprobado", reject: "rechazado", reopen: "reabierto", verdict_block: "Veredicto del motor", acknowledged_by: "Aceptado por", accepted_as: "aceptado como no cumplido", not_acknowledged: "no aceptado", gtfs_validation_line: "Validación del GTFS: {status}, {errors} error(es), {preexisting} ya en la referencia ({engine}).", not_deliverable: "Esta versión no cumple todas las cláusulas obligatorias: se aprobó con las aceptaciones indicadas arriba.", not_checked: "aún no comprobado", valid: "válido", valid_with_preexisting: "válido, errores preexistentes conservados", acknowledged: "Aceptado" },
  de: { from_coherence: "laut Kohärenzbericht von {version} vom {date}", role_reader: "Leser", role_contributor: "Mitwirkender", role_approver: "Freigeber", synthesis: "Zusammenfassung", annex: "Technischer Anhang", comparison: "Szenarienvergleich", project: "Projekt", client: "Auftraggeber", territory: "Gebiet", context: "Kontext", prepared: "Erstellt am", version: "Freigegebene Version", reference: "Referenz", figures: "Kennzahlen", figure: "Kennzahl", before: "Referenz", after: "Freigegebenes Szenario", basis: "Grundlage", measured: "gemessen", estimated: "geschätzt", assumption: "Annahme", lines: "Linien", trips: "Fahrten", fleet: "Fahrzeuge in der Spitze", veh_km: "Fahrzeug-km pro Jahr", veh_h: "Fahrzeugstunden pro Jahr", cost: "Betriebskosten pro Jahr", quality: "Netzqualitätsnote", objectives: "Der Vertrag (Ziele)", objective: "Ziel", level: "Stufe", status: "Status", verdict: "Ergebnis", quote: "Die Worte der Ausschreibung", measured_as: "Gemessen", pass: "erfüllt", fail: "nicht erfüllt", unknown: "nicht messbar", scenarios: "Verglichene Szenarien", scenario: "Szenario", must: "Pflicht erfüllt", should: "Wunsch erfüllt", approved_scenario: "Das freigegebene Szenario", approved: "freigegeben", decisions: "Entscheidungen", date: "Datum", who: "Von", action: "Aktion", comment: "Kommentar", comments: "Offene Kommentare", operations: "Operationen des Plans", operation: "Operation", step: "Was die Engine tat", validation: "Validierung des GTFS", assumptions: "Annahmen", cost_note: "Kosten mit {cpk} {cur} pro km berechnet, dem Standardwert, da die Einheitskosten des Vertrags fehlen: tragen Sie sie im Projekt ein, damit sie gemessen sind.", no_objective: "Kein Ziel wurde bestätigt.", none: "Keine.", adjusted: "Das freigegebene Szenario wurde auf der Karte angepasst: seine Zahlen sind am angepassten Feed gemessen.", tender: "Ausschreibung", amendment: "Vertragsänderung", study: "Studie", other: "Sonstiges", validated: "bestätigt", corrected: "korrigiert", waived: "verworfen", proposed: "vorgeschlagen", draft: "Entwurf", in_review: "in Prüfung", rejected: "abgelehnt", submit: "eingereicht", approve: "freigegeben", reject: "abgelehnt", reopen: "wieder geöffnet", verdict_block: "Ergebnis der Engine", acknowledged_by: "Anerkannt von", accepted_as: "als nicht erfüllt anerkannt", not_acknowledged: "nicht anerkannt", gtfs_validation_line: "Validierung des GTFS: {status}, {errors} Fehler, {preexisting} bereits in der Referenz ({engine}).", not_deliverable: "Diese Version erfüllt nicht alle Pflichtklauseln: sie wurde mit den oben genannten Anerkennungen freigegeben.", not_checked: "noch nicht geprüft", valid: "gültig", valid_with_preexisting: "gültig, bereits vorhandene Fehler bleiben", acknowledged: "Anerkannt" },
  pt: { from_coherence: "segundo o relatório de coerência de {version} de {date}", role_reader: "leitor", role_contributor: "colaborador", role_approver: "aprovador", synthesis: "Nota de síntese", annex: "Anexo técnico", comparison: "Comparação de cenários", project: "Projeto", client: "Cliente", territory: "Território", context: "Contexto", prepared: "Elaborada em", version: "Versão aprovada", reference: "Referência", figures: "Números-chave", figure: "Indicador", before: "Referência", after: "Cenário aprovado", basis: "Base", measured: "medido", estimated: "estimado", assumption: "hipótese", lines: "Linhas", trips: "Viagens", fleet: "Veículos na ponta", veh_km: "Veículos-km por ano", veh_h: "Horas de serviço por ano", cost: "Custo de exploração anual", quality: "Nota de qualidade da rede", objectives: "O contrato (objetivos)", objective: "Objetivo", level: "Nível", status: "Estado", verdict: "Veredicto", quote: "As palavras do caderno de encargos", measured_as: "Medido", pass: "cumprido", fail: "não cumprido", unknown: "não mensurável", scenarios: "Cenários comparados", scenario: "Cenário", must: "Obrigatórios cumpridos", should: "Desejáveis cumpridos", approved_scenario: "O cenário aprovado", approved: "aprovado", decisions: "Decisões", date: "Data", who: "Por", action: "Ação", comment: "Comentário", comments: "Comentários em aberto", operations: "Operações do plano", operation: "Operação", step: "O que o motor fez", validation: "Validação do GTFS", assumptions: "Hipóteses", cost_note: "Custos calculados com {cpk} {cur} por km, o valor por omissão, na falta dos custos unitários do contrato: indique-os no projeto para que sejam medidos.", no_objective: "Nenhum objetivo foi validado.", none: "Nenhum.", adjusted: "O cenário aprovado foi ajustado no mapa: os seus números são medidos no feed ajustado.", tender: "Concurso", amendment: "Aditamento", study: "Estudo", other: "Outro", validated: "validado", corrected: "corrigido", waived: "afastado", proposed: "proposto", draft: "rascunho", in_review: "em revisão", rejected: "rejeitado", submit: "submetido", approve: "aprovado", reject: "rejeitado", reopen: "reaberto", verdict_block: "Veredicto do motor", acknowledged_by: "Aceite por", accepted_as: "aceite como não cumprido", not_acknowledged: "não aceite", gtfs_validation_line: "Validação do GTFS: {status}, {errors} erro(s), {preexisting} já na referência ({engine}).", not_deliverable: "Esta versão não cumpre todas as cláusulas obrigatórias: foi aprovada com as aceitações indicadas acima.", not_checked: "ainda não verificado", valid: "válido", valid_with_preexisting: "válido, erros preexistentes mantidos", acknowledged: "Aceite" },
  zh: { from_coherence: "依据 {version}（{date}）的一致性报告", role_reader: "读者", role_contributor: "贡献者", role_approver: "审批人", synthesis: "综合说明", annex: "技术附件", comparison: "方案比较", project: "项目", client: "客户", territory: "区域", context: "背景", prepared: "编制日期", version: "已批准版本", reference: "基准", figures: "关键数据", figure: "指标", before: "基准", after: "已批准方案", basis: "依据", measured: "实测", estimated: "估算", assumption: "假设", lines: "线路", trips: "班次", fleet: "高峰车辆数", veh_km: "年车公里", veh_h: "年车小时", cost: "年运营成本", quality: "线网质量评分", objectives: "合同（目标）", objective: "目标", level: "级别", status: "状态", verdict: "结论", quote: "任务书原文", measured_as: "实测值", pass: "满足", fail: "未满足", unknown: "无法测量", scenarios: "比较的方案", scenario: "方案", must: "必须项满足", should: "期望项满足", approved_scenario: "已批准的方案", approved: "已批准", decisions: "决定", date: "日期", who: "执行人", action: "操作", comment: "意见", comments: "未关闭的意见", operations: "方案的操作", operation: "操作", step: "引擎所做的处理", validation: "GTFS 校验", assumptions: "假设", cost_note: "由于缺少合同单价，成本按默认值每公里 {cpk} {cur} 计算：在项目中填写单价后即为实测值。", no_objective: "尚无已确认的目标。", none: "无。", adjusted: "已批准的方案在地图上做过调整：其数据基于调整后的数据集实测。", tender: "招标", amendment: "合同变更", study: "研究", other: "其他", validated: "已确认", corrected: "已修正", waived: "已放弃", proposed: "建议", draft: "草稿", in_review: "审核中", rejected: "已驳回", submit: "已提交", approve: "已批准", reject: "已驳回", reopen: "已重新打开", verdict_block: "引擎结论", acknowledged_by: "确认人", accepted_as: "接受为未满足", not_acknowledged: "未确认", gtfs_validation_line: "GTFS 校验：{status}，{errors} 个错误，其中 {preexisting} 个在基准中已存在（{engine}）。", not_deliverable: "该版本未满足全部必须条款：已在上述确认下批准。", not_checked: "尚未校验", valid: "有效", valid_with_preexisting: "有效，保留原有错误", acknowledged: "已确认" },
  ar: { from_coherence: "وفق تقرير الاتساق لـ {version} بتاريخ {date}", role_reader: "قارئ", role_contributor: "مساهم", role_approver: "معتمِد", synthesis: "مذكرة تلخيصية", annex: "ملحق تقني", comparison: "مقارنة السيناريوهات", project: "المشروع", client: "العميل", territory: "المنطقة", context: "السياق", prepared: "أُعدّت في", version: "النسخة المعتمدة", reference: "المرجع", figures: "الأرقام الرئيسية", figure: "المؤشر", before: "المرجع", after: "السيناريو المعتمد", basis: "الأساس", measured: "مقاس", estimated: "تقديري", assumption: "افتراض", lines: "الخطوط", trips: "الرحلات", fleet: "المركبات في الذروة", veh_km: "مركبة-كم سنوياً", veh_h: "ساعات الخدمة سنوياً", cost: "تكلفة التشغيل السنوية", quality: "درجة جودة الشبكة", objectives: "العقد (الأهداف)", objective: "الهدف", level: "المستوى", status: "الحالة", verdict: "النتيجة", quote: "نص دفتر الشروط", measured_as: "القيمة المقاسة", pass: "متحقق", fail: "غير متحقق", unknown: "غير قابل للقياس", scenarios: "السيناريوهات المقارنة", scenario: "السيناريو", must: "الإلزامي المتحقق", should: "المرغوب المتحقق", approved_scenario: "السيناريو المعتمد", approved: "معتمد", decisions: "القرارات", date: "التاريخ", who: "بواسطة", action: "الإجراء", comment: "التعليق", comments: "تعليقات مفتوحة", operations: "عمليات الخطة", operation: "العملية", step: "ما قام به المحرك", validation: "التحقق من GTFS", assumptions: "الافتراضات", cost_note: "حُسبت التكاليف بـ {cpk} {cur} لكل كم، وهي القيمة الافتراضية، لعدم توفر التكاليف الأحادية للعقد: أدخلها في المشروع لتصبح مقاسة.", no_objective: "لم يُعتمد أي هدف.", none: "لا شيء.", adjusted: "عُدّل السيناريو المعتمد على الخريطة: أرقامه مقاسة على البيانات المعدّلة.", tender: "مناقصة", amendment: "تعديل عقد", study: "دراسة", other: "أخرى", validated: "معتمد", corrected: "مصحّح", waived: "مستبعد", proposed: "مقترح", draft: "مسودة", in_review: "قيد المراجعة", rejected: "مرفوض", submit: "مُرسل", approve: "معتمد", reject: "مرفوض", reopen: "أعيد فتحه", verdict_block: "نتيجة المحرك", acknowledged_by: "أقرّ به", accepted_as: "قُبل كغير متحقق", not_acknowledged: "غير مُقرّ", gtfs_validation_line: "التحقق من GTFS: {status}، {errors} خطأ، {preexisting} موجودة مسبقاً في المرجع ({engine}).", not_deliverable: "هذه النسخة لا تحقق كل البنود الإلزامية: اعتُمدت مع الإقرارات المذكورة أعلاه.", not_checked: "لم يُتحقق منه بعد", valid: "صالح", valid_with_preexisting: "صالح، مع الأخطاء الموجودة مسبقاً", acknowledged: "مُقرّ" },
  hi: { from_coherence: "{version} ({date}) की सुसंगति रिपोर्ट के अनुसार", role_reader: "पाठक", role_contributor: "योगदानकर्ता", role_approver: "अनुमोदक", synthesis: "सारांश नोट", annex: "तकनीकी परिशिष्ट", comparison: "परिदृश्यों की तुलना", project: "परियोजना", client: "ग्राहक", territory: "क्षेत्र", context: "संदर्भ", prepared: "तैयार करने की तिथि", version: "स्वीकृत संस्करण", reference: "संदर्भ", figures: "मुख्य आँकड़े", figure: "संकेतक", before: "संदर्भ", after: "स्वीकृत परिदृश्य", basis: "आधार", measured: "मापा गया", estimated: "अनुमानित", assumption: "धारणा", lines: "लाइनें", trips: "यात्राएँ", fleet: "पीक पर वाहन", veh_km: "वार्षिक वाहन-किमी", veh_h: "वार्षिक वाहन-घंटे", cost: "वार्षिक संचालन लागत", quality: "नेटवर्क गुणवत्ता अंक", objectives: "अनुबंध (लक्ष्य)", objective: "लक्ष्य", level: "स्तर", status: "स्थिति", verdict: "निष्कर्ष", quote: "विनिर्देश के शब्द", measured_as: "मापा गया मान", pass: "पूरा", fail: "पूरा नहीं", unknown: "मापा नहीं जा सकता", scenarios: "तुलना किए गए परिदृश्य", scenario: "परिदृश्य", must: "अनिवार्य पूरे", should: "वांछित पूरे", approved_scenario: "स्वीकृत परिदृश्य", approved: "स्वीकृत", decisions: "निर्णय", date: "तिथि", who: "द्वारा", action: "कार्रवाई", comment: "टिप्पणी", comments: "खुली टिप्पणियाँ", operations: "योजना के संचालन", operation: "संचालन", step: "इंजन ने क्या किया", validation: "GTFS सत्यापन", assumptions: "धारणाएँ", cost_note: "अनुबंध की इकाई लागत के अभाव में लागत डिफ़ॉल्ट {cpk} {cur} प्रति किमी से गणना की गई है: उन्हें परियोजना में भरें ताकि वे मापी गई हों।", no_objective: "कोई लक्ष्य स्वीकृत नहीं हुआ।", none: "कोई नहीं।", adjusted: "स्वीकृत परिदृश्य को मानचित्र पर समायोजित किया गया: उसके आँकड़े समायोजित फ़ीड पर मापे गए हैं।", tender: "निविदा", amendment: "अनुबंध संशोधन", study: "अध्ययन", other: "अन्य", validated: "स्वीकृत", corrected: "सुधारा गया", waived: "हटाया गया", proposed: "प्रस्तावित", draft: "मसौदा", in_review: "समीक्षा में", rejected: "अस्वीकृत", submit: "प्रस्तुत", approve: "स्वीकृत", reject: "अस्वीकृत", reopen: "फिर खोला गया", verdict_block: "इंजन का निष्कर्ष", acknowledged_by: "स्वीकृति द्वारा", accepted_as: "पूरा न होने के रूप में स्वीकृत", not_acknowledged: "स्वीकृत नहीं", gtfs_validation_line: "GTFS सत्यापन: {status}, {errors} त्रुटि(याँ), {preexisting} संदर्भ में पहले से मौजूद ({engine})।", not_deliverable: "यह संस्करण सभी अनिवार्य शर्तें पूरी नहीं करता: इसे ऊपर सूचीबद्ध स्वीकृतियों के साथ अनुमोदित किया गया।", not_checked: "अभी जाँच नहीं हुई", valid: "मान्य", valid_with_preexisting: "मान्य, पहले से मौजूद त्रुटियाँ यथावत", acknowledged: "स्वीकृत" },
};

// The label separator: French puts a space before the colon, Chinese uses the full-width colon.
const SEP = { fr: " : ", zh: "：" };
const labelsOf = (language) => ({ ...LABELS.en, ...(LABELS[language] || {}), sep: SEP[language] || ": " });

const fmt = (n, language) => (n == null || !Number.isFinite(Number(n)) ? "—" : Number(n).toLocaleString(language === "zh" ? "zh-CN" : language === "ar" ? "ar" : language === "hi" ? "hi-IN" : language || "en"));
const basisOf = (f, L) => (f?.basis ? L[f.basis] || f.basis : "—");
const day = () => new Date().toISOString().slice(0, 10);
// A member as a client document names them: the display name, else the role (never the email).
const nameOf = (state, userId, L) => {
  const m = state.members.find((x) => x.user_id === userId);
  return m?.display_name || (m ? L[`role_${m.role}`] || m.role : "—");
};

// What an approval froze: its plan and its contract (objectives), with the live ones as a fallback
// for versions frozen before they were recorded.
const frozenOf = (v, scenario, state) => ({
  plan: v.measures?.plan || scenario?.plan || null,
  objectives: v.measures?.objectives || state.objectives,
});

/** The figures rows (reference and approved), each with its basis. */
const figureRows = (before, after, L, language) =>
  [
    ["lines", "lines"],
    ["trips", "trips"],
    ["fleet", "fleet"],
    ["veh_km", "veh_km_year"],
    ["veh_h", "veh_h_year"],
    ["cost", "cost_year"],
    ["quality", "quality"],
  ].map(([label, key]) => [L[label], fmt(before?.[key]?.value, language), fmt(after?.[key]?.value, language), basisOf(after?.[key] || before?.[key], L)]);

const contractOf = (objectives) => objectives.filter((o) => o.status === "validated" || o.status === "corrected");

// The clause's id is its objective's own id (projectMeasures.requirementsOf): one row, one verdict.
const resultOf = (conformance, o) => {
  const byId = new Map((conformance?.results || []).map((r) => [r.id, r]));
  return byId.get(o.id) || byId.get(o.clause?.id) || null;
};

/**
 * Where a clause comes from when it is not the brief's words: a row of the coherence report (mission step 7,
 * clause.origin) is said as such — « d'après le rapport de cohérence de v1 du … » — never printed as a quote.
 */
const originText = (clause, L) => (clause?.origin?.kind === "coherence_row" ? L.from_coherence.replace("{version}", clause.origin.version || "—").replace("{date}", clause.origin.date || "—") : null);

/** The contract rows (objective, level, the brief's words): what was asked, in the brief's words. */
const contractRows = (objectives, L) => contractOf(objectives).map((o) => [o.clause?.text || o.clause?.kind, o.clause?.level === "should" ? "should" : "must", originText(o.clause, L) || (o.quote ? `« ${o.quote} »` : L.assumption)]);

/**
 * The verdict rows (G3, G4): the engine's status per clause — a not measurable one with the
 * engine's note — what it measured, and for every must clause not met, WHO acknowledged it and
 * WHEN (the approval's record, version.measures.gate.acknowledgement), else "not acknowledged".
 */
const verdictRows = (conformance, objectives, L, acknowledgement = null) => {
  const acknowledged = new Set(acknowledgement?.clauses || []);
  const who = acknowledgement?.by?.name ? `${acknowledgement.by.name} — ${String(acknowledgement.at || "").slice(0, 10)}` : L.not_acknowledged;
  return contractOf(objectives).map((o) => {
    const r = resultOf(conformance, o);
    const status = r ? L[r.status] || r.status : L.unknown;
    const level = o.clause?.level === "should" ? "should" : "must";
    const unmet = level === "must" && (!r || r.status === "fail" || r.status === "unknown");
    const measured = r?.status === "unknown" ? r.note || r.measured || "—" : r?.measured || "—";
    return [o.clause?.text || o.clause?.kind, level, status, measured, unmet ? (acknowledged.has(r?.id || o.id) ? who : L.not_acknowledged) : "—"];
  });
};

/** The GTFS validation line of the version (v.validation, written at approval or at the first deliverable). */
const validationLine = (validation, L) => {
  if (!validation || typeof validation.errors !== "number") return L.gtfs_validation_line.replace("{status}", L.not_checked).replace("{errors}", "—").replace("{preexisting}", "—").replace("{engine}", "—");
  const status = L[validation.status] || validation.status || "—";
  return L.gtfs_validation_line.replace("{status}", status).replace("{errors}", String(validation.errors)).replace("{preexisting}", String(validation.preexisting ?? 0)).replace("{engine}", validation.engine || "—");
};

/**
 * The verdict block that opens every document, before any figure: the engine's verdict clause by
 * clause with the acknowledgements, a note when a must clause is not met, the GTFS validation line.
 */
const verdictBlocks = (v, m, objectives, L) => {
  const ack = v.measures?.gate?.acknowledgement || null;
  const blocks = [{ h: 1, text: L.verdict_block }];
  const rows = verdictRows(m?.conformance?.after, objectives, L, ack);
  if (rows.length) blocks.push({ table: { head: [L.objective, L.level, L.verdict, L.measured_as, L.acknowledged_by], rows } });
  else blocks.push({ p: L.no_objective });
  if (rows.some((r) => r[1] === "must" && r[2] !== L.pass)) blocks.push({ note: L.not_deliverable });
  blocks.push({ p: validationLine(v.validation, L) });
  return blocks;
};

/** What a review acknowledged, as the decisions table prints it: the name and the clauses accepted as not met / not measurable. */
const acknowledgedCell = (review, L) => {
  const a = review.acknowledgement;
  if (!a) return "—";
  const items = (a.items || []).filter((i) => i.kind === "clause").map((i) => `${i.text || i.id} (${L[i.status] || i.status})`);
  return `${a.by?.name || "—"}${items.length ? `${L.sep}${L.accepted_as} ${items.join("; ")}` : ""}`;
};

const blocksSynthesis = async (ctx, L) => {
  const { project: p, version: v, state } = ctx;
  const language = p.language || "en";
  const scenario = state.scenarios.find((s) => s.id === v.scenario_id) || null;
  const frozen = frozenOf(v, scenario, state);
  const m = v.measures?.scenario || (scenario ? await ctx.evaluate(scenario) : null);
  const before = m?.figures?.before;
  const after = m?.figures?.after;
  const blocks = [];
  blocks.push({ p: [{ text: `${L.project}${L.sep}`, bold: true }, { text: p.name }] });
  if (p.client) blocks.push({ p: [{ text: `${L.client}${L.sep}`, bold: true }, { text: p.client }] });
  if (p.territory) blocks.push({ p: [{ text: `${L.territory}${L.sep}`, bold: true }, { text: p.territory }] });
  blocks.push({ p: [{ text: `${L.context}${L.sep}`, bold: true }, { text: L[p.context] || p.context || "—" }] });
  blocks.push({ p: [{ text: `${L.version}${L.sep}`, bold: true }, { text: `${v.label || v.id} (${v.created_at?.slice(0, 10) || ""})` }] });
  blocks.push({ p: [{ text: `${L.prepared}${L.sep}`, bold: true }, { text: day() }] });
  // The engine's verdict first (G3): before any figure, never after prose.
  blocks.push(...verdictBlocks(v, m, frozen.objectives, L));
  blocks.push({ h: 1, text: L.figures });
  blocks.push({ table: { head: [L.figure, L.before, L.after, L.basis], rows: figureRows(before, after, L, language) } });
  if (after?.cost_year?.basis === "estimated") blocks.push({ note: L.cost_note.replace("{cpk}", String(after.cost_year.assumption?.cost_per_km ?? "")).replace("{cur}", after.cost_year.currency || p.currency || "EUR") });
  if (m?.source === "version") blocks.push({ note: L.adjusted });
  blocks.push({ h: 1, text: L.objectives });
  const cr = contractRows(frozen.objectives, L);
  if (cr.length) blocks.push({ table: { head: [L.objective, L.level, L.quote], rows: cr } });
  else blocks.push({ p: L.no_objective });
  blocks.push({ h: 1, text: L.scenarios });
  const rows = [];
  for (const s of state.scenarios) {
    // Measured now (the cache is keyed on plan, contract, reference, costs and country): never a stale figure.
    const sm = await ctx.evaluate(s);
    const f = sm?.figures?.after || {};
    const c = sm?.conformance?.after?.summary;
    rows.push([s.name, L[s.status] || s.status, c ? `${c.must?.pass ?? 0}/${c.must?.total ?? 0}` : "—", fmt(f.fleet?.value, language), fmt(f.veh_km_year?.value, language), fmt(f.cost_year?.value, language)]);
  }
  blocks.push({ table: { head: [L.scenario, L.status, L.must, L.fleet, L.veh_km, L.cost], rows } });
  if (scenario) {
    blocks.push({ h: 1, text: L.approved_scenario });
    blocks.push({ p: [{ text: scenario.name, bold: true }, { text: frozen.plan?.title ? ` — ${frozen.plan.title}` : "" }] });
    for (const a of frozen.plan?.assumptions || []) blocks.push({ li: `${a.text}${a.confidence ? ` (${a.confidence})` : ""}` });
  }
  blocks.push({ h: 1, text: L.decisions });
  const decisions = state.reviews.map((r) => [r.created_at?.slice(0, 16).replace("T", " "), nameOf(state, r.actor, L), L[r.to_status === "in_review" ? "submit" : r.to_status === "approved" ? "approve" : r.to_status === "rejected" ? "reject" : "reopen"], r.comment || "—", acknowledgedCell(r, L)]);
  if (decisions.length) blocks.push({ table: { head: [L.date, L.who, L.action, L.comment, L.acknowledged], rows: decisions } });
  else blocks.push({ p: L.none });
  const open = state.comments.filter((c) => !c.resolved_at);
  blocks.push({ h: 1, text: L.comments });
  if (open.length) for (const c of open) blocks.push({ li: `${nameOf(state, c.author, L)}${L.sep}${c.body}` });
  else blocks.push({ p: L.none });
  return blocks;
};

const blocksAnnex = async (ctx, L) => {
  const { project: p, version: v, state } = ctx;
  const language = p.language || "en";
  const scenario = state.scenarios.find((s) => s.id === v.scenario_id) || null;
  const frozen = frozenOf(v, scenario, state);
  const m = v.measures?.scenario || (scenario ? await ctx.evaluate(scenario) : null);
  const blocks = [{ p: [{ text: `${L.project}${L.sep}`, bold: true }, { text: p.name }] }, { p: [{ text: `${L.version}${L.sep}`, bold: true }, { text: `${v.label || v.id} · sha256 ${v.sha256 || "—"}` }] }];
  // The engine's verdict first (G3), before the operations and the figures.
  blocks.push(...verdictBlocks(v, m, frozen.objectives, L));
  blocks.push({ h: 1, text: L.operations });
  // The operations the approval froze, never a later edit of the scenario.
  const ops = frozen.plan?.operations || [];
  if (ops.length) {
    const stepOf = new Map((m?.steps || []).map((s) => [s.id, s]));
    blocks.push({ table: { head: ["#", L.operation, L.quote, L.step], rows: ops.map((o, i) => [String(i + 1), `${o.type} ${JSON.stringify(o.params || {})}`.slice(0, 600), o.source?.quote ? `« ${o.source.quote} »` : "—", stepOf.get(o.id)?.summary || stepOf.get(o.id)?.status || "—"]) } });
  } else blocks.push({ p: m?.source === "version" ? L.adjusted : L.none });
  blocks.push({ h: 1, text: L.objectives });
  const cr = contractRows(frozen.objectives, L);
  if (cr.length) blocks.push({ table: { head: [L.objective, L.level, L.quote], rows: cr } });
  else blocks.push({ p: L.no_objective });
  blocks.push({ h: 1, text: L.figures });
  blocks.push({ table: { head: [L.figure, L.before, L.after, L.basis], rows: figureRows(m?.figures?.before, m?.figures?.after, L, language) } });
  const assumptions = frozen.plan?.assumptions || [];
  if (assumptions.length) {
    blocks.push({ h: 1, text: L.assumptions });
    for (const a of assumptions) blocks.push({ li: `${a.text}${a.operation ? ` [${a.operation}]` : ""}${a.confidence ? ` (${a.confidence})` : ""}` });
  }
  return blocks;
};

// A text a spreadsheet would run as a formula (=, +, -, @, tab, CR at its start) is prefixed with a quote;
// numbers are written as they are.
const csvCell = (x) => {
  const raw = x == null ? "" : String(x);
  const s = typeof x !== "number" && /^[=+\-@\t\r]/.test(raw) ? `'${raw}` : raw;
  return /[",\n;]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

const buildComparison = async (ctx, L) => {
  const { state } = ctx;
  const head = [L.scenario, L.status, L.must, L.should, L.lines, L.trips, L.fleet, L.veh_km, L.veh_h, L.cost, `${L.cost} (${L.basis})`, L.quality];
  const rows = [];
  let ref = null;
  for (const s of state.scenarios) {
    const m = await ctx.evaluate(s);
    if (!ref && m?.figures?.before) ref = m;
    const f = m?.figures?.after || {};
    const c = m?.conformance?.after?.summary;
    rows.push([s.name, L[s.status] || s.status, c ? `${c.must?.pass ?? 0}/${c.must?.total ?? 0}` : "", c ? `${c.should?.pass ?? 0}/${c.should?.total ?? 0}` : "", f.lines?.value, f.trips?.value, f.fleet?.value, f.veh_km_year?.value, f.veh_h_year?.value, f.cost_year?.value, basisOf(f.cost_year, L), f.quality?.value]);
  }
  if (ref) {
    const f = ref.figures.before;
    const c = ref.conformance?.before?.summary;
    rows.unshift([L.reference, "", c ? `${c.must?.pass ?? 0}/${c.must?.total ?? 0}` : "", c ? `${c.should?.pass ?? 0}/${c.should?.total ?? 0}` : "", f.lines?.value, f.trips?.value, f.fleet?.value, f.veh_km_year?.value, f.veh_h_year?.value, f.cost_year?.value, basisOf(f.cost_year, L), f.quality?.value]);
  }
  // A BOM so spreadsheet software reads the accents; CRLF like the GTFS export.
  return `﻿${[head, ...rows].map((r) => r.map(csvCell).join(",")).join("\r\n")}\r\n`;
};

/**
 * The GTFS deliverable, validated before anything is zipped (G1). ctx.validateVersion() is the
 * controller's: the version's verified report (validatorGate — 503 VALIDATOR_UNAVAILABLE /
 * VALIDATOR_FAILED when it cannot answer, nothing delivered) and the reference version's report
 * as the baseline. A new error above the baseline refuses (409 VALIDATION_NEW_ERRORS); without a
 * baseline the feed must carry no error (409 VALIDATION_ERRORS). Pre-existing errors of the
 * reference are delivered announced (status valid_with_preexisting, preexisting count).
 */
const buildGtfs = async (ctx, target) => {
  const validatorGate = require("../validatorGate");
  if (typeof ctx.validateVersion !== "function") throw Object.assign(new Error("The GTFS deliverable needs the version's validation."), { status: 503, code: "VALIDATOR_UNAVAILABLE", details: { reason: "not_installed" } });
  const { report, baseline } = await ctx.validateVersion();
  validatorGate.assertVerified(report);
  const cmp = baseline ? validatorGate.assertNoNewErrors(baseline, report) : (validatorGate.assertCreationValid(report), null);
  const preexisting = cmp?.preexisting || 0;
  const summary = validatorGate.summaryOf(report);
  const validation = { status: preexisting ? "valid_with_preexisting" : "valid", errors: summary.errors, warnings: summary.warnings, new_errors: [], preexisting, engine: summary.engine, validator: "MobilityData" };
  const dir = files.scratchDir(ctx.project.id);
  try {
    const gtfsDir = path.join(dir, "gtfs");
    measures.exportGtfsDir(ctx.version.file, gtfsDir);
    const archiver = require("archiver");
    await new Promise((resolve, reject) => {
      const out = fs.createWriteStream(target);
      const zip = archiver("zip", { zlib: { level: 9 } });
      out.on("close", resolve);
      zip.on("error", reject);
      zip.pipe(out);
      for (const f of fs.readdirSync(gtfsDir).filter((x) => x.endsWith(".txt")).sort()) zip.file(path.join(gtfsDir, f), { name: f });
      zip.finalize();
    });
    return validation;
  } finally {
    files.removeQuietly(dir);
  }
};

/** build(kind, { project, version: { …, file }, format, state, evaluate, validateVersion }) → { path, format, validation? } */
const build = async (kind, ctx) => {
  const L = labelsOf(ctx.project.language || "en");
  const id = require("./projectStore").newId();
  if (kind === "gtfs") {
    const target = files.deliverablePath(ctx.project.id, id, "zip");
    try {
      const validation = await buildGtfs(ctx, target);
      return { path: target, format: "zip", validation };
    } catch (err) {
      files.removeQuietly(target);
      throw err;
    }
  }
  if (kind === "comparison") {
    const target = files.deliverablePath(ctx.project.id, id, "csv");
    fs.writeFileSync(target, await buildComparison(ctx, L));
    return { path: target, format: "csv" };
  }
  const blocks = kind === "synthesis" ? await blocksSynthesis(ctx, L) : await blocksAnnex(ctx, L);
  const title = `${kind === "synthesis" ? L.synthesis : L.annex} — ${ctx.project.name}`;
  if (ctx.format === "md") {
    const target = files.deliverablePath(ctx.project.id, id, "md");
    fs.writeFileSync(target, toMarkdown({ blocks, title }));
    return { path: target, format: "md" };
  }
  const target = files.deliverablePath(ctx.project.id, id, "docx");
  fs.writeFileSync(target, await toDocx({ blocks, title, language: ctx.project.language || "en" }));
  return { path: target, format: "docx" };
};

module.exports = { build, LABELS, labelsOf, _internals: { blocksSynthesis, blocksAnnex, buildComparison, figureRows, verdictRows, contractRows, verdictBlocks, validationLine, acknowledgedCell, buildGtfs, csvCell } };
