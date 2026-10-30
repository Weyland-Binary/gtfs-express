/**
 * The e-mails' words: the sign-in code and the trial's three messages in the language the person reads the site
 * in, the quote request in French for the operator who answers it.
 */

"use strict";

const CODE = {
  fr: { subject: "Votre code de connexion GTFS Express : {code}", lines: ["Votre code de connexion : {code}", "Il est valable 10 minutes et ne sert qu'une fois.", "Si vous n'avez pas demandé ce code, ignorez ce message : personne ne peut se connecter sans lui."] },
  en: { subject: "Your GTFS Express sign-in code: {code}", lines: ["Your sign-in code: {code}", "It is valid for 10 minutes and works once.", "If you did not ask for this code, ignore this message: nobody can sign in without it."] },
  es: { subject: "Su código de acceso a GTFS Express: {code}", lines: ["Su código de acceso: {code}", "Es válido durante 10 minutos y solo sirve una vez.", "Si no ha solicitado este código, ignore este mensaje: nadie puede acceder sin él."] },
  de: { subject: "Ihr Anmeldecode für GTFS Express: {code}", lines: ["Ihr Anmeldecode: {code}", "Er ist 10 Minuten gültig und nur einmal verwendbar.", "Wenn Sie diesen Code nicht angefordert haben, ignorieren Sie diese Nachricht: Ohne ihn kann sich niemand anmelden."] },
  pt: { subject: "O seu código de acesso ao GTFS Express: {code}", lines: ["O seu código de acesso: {code}", "É válido durante 10 minutos e só serve uma vez.", "Se não pediu este código, ignore esta mensagem: ninguém pode entrar sem ele."] },
  zh: { subject: "您的 GTFS Express 登录验证码：{code}", lines: ["您的登录验证码：{code}", "验证码 10 分钟内有效，且只能使用一次。", "如果您没有申请此验证码，请忽略本邮件：没有它，任何人都无法登录。"] },
  hi: { subject: "आपका GTFS Express साइन-इन कोड: {code}", lines: ["आपका साइन-इन कोड: {code}", "यह 10 मिनट तक मान्य है और केवल एक बार काम करता है।", "अगर आपने यह कोड नहीं माँगा है, तो इस संदेश को अनदेखा करें: इसके बिना कोई साइन इन नहीं कर सकता।"] },
};

const fill = (s, vars) => s.replace(/\{(\w+)\}/g, (_, k) => (vars[k] != null ? String(vars[k]) : ""));

const loginCodeMessage = (code, language = "fr") => {
  const lang = CODE[String(language || "").slice(0, 2).toLowerCase()] || CODE.en;
  const text = `${lang.lines.map((l) => fill(l, { code })).join("\n\n")}\n\nGTFS Express`;
  return { subject: fill(lang.subject, { code }), text };
};

// The free trial's messages: {date} its end in the reader's language, {ai} the assistant's envelope (« 5 € »), {link}
// the site's address (a line without it when the server knows none). Plain service messages, no marketing.
const TRIAL = {
  fr: {
    started: { subject: "Votre essai GTFS Express a commencé", lines: ["Votre essai gratuit de GTFS Express a commencé. Il dure jusqu'au {date}.", "Pendant l'essai, vous pouvez tout essayer : modifier un réseau, le Change Studio, l'assistant (dans la limite de {ai} de consommation). Le réseau modifié reste dans l'application : l'export, la livraison et le partage s'ouvrent avec la licence.", "{link}"] },
    ending: { subject: "Votre essai GTFS Express se termine le {date}", lines: ["Votre essai gratuit de GTFS Express se termine le {date}.", "Votre travail est conservé. Pour continuer et livrer le réseau modifié, prenez la licence en ligne ou demandez un devis depuis l'offre.", "{link}"] },
    ended: { subject: "Votre essai GTFS Express est terminé", lines: ["Votre essai gratuit de GTFS Express est terminé.", "Votre travail vous attend : il est conservé et sortira avec la licence, en ligne ou sur devis. La lecture des réseaux reste gratuite.", "{link}"] },
    open: "Ouvrir GTFS Express : {url}",
  },
  en: {
    started: { subject: "Your GTFS Express trial has started", lines: ["Your free trial of GTFS Express has started. It runs until {date}.", "During the trial you can try everything: modifying a network, the Change Studio, the assistant (up to {ai} of use). The modified network stays in the application: exporting, delivering and sharing open with the licence.", "{link}"] },
    ending: { subject: "Your GTFS Express trial ends on {date}", lines: ["Your free trial of GTFS Express ends on {date}.", "Your work is kept. To go on and deliver the modified network, take the licence online or ask for a quote from the offer.", "{link}"] },
    ended: { subject: "Your GTFS Express trial has ended", lines: ["Your free trial of GTFS Express has ended.", "Your work is waiting for you: it is kept and will leave with the licence, online or on a quote. Reading networks stays free.", "{link}"] },
    open: "Open GTFS Express: {url}",
  },
  es: {
    started: { subject: "Su prueba de GTFS Express ha comenzado", lines: ["Su prueba gratuita de GTFS Express ha comenzado. Dura hasta el {date}.", "Durante la prueba puede probarlo todo: modificar una red, el Change Studio, el asistente (hasta {ai} de consumo). La red modificada permanece en la aplicación: la exportación, la entrega y el uso compartido se abren con la licencia.", "{link}"] },
    ending: { subject: "Su prueba de GTFS Express termina el {date}", lines: ["Su prueba gratuita de GTFS Express termina el {date}.", "Su trabajo se conserva. Para continuar y entregar la red modificada, adquiera la licencia en línea o solicite un presupuesto desde la oferta.", "{link}"] },
    ended: { subject: "Su prueba de GTFS Express ha terminado", lines: ["Su prueba gratuita de GTFS Express ha terminado.", "Su trabajo le espera: se conserva y saldrá con la licencia, en línea o con presupuesto. La lectura de redes sigue siendo gratuita.", "{link}"] },
    open: "Abrir GTFS Express: {url}",
  },
  de: {
    started: { subject: "Ihre GTFS-Express-Testphase hat begonnen", lines: ["Ihre kostenlose Testphase von GTFS Express hat begonnen. Sie läuft bis zum {date}.", "Während der Testphase können Sie alles ausprobieren: ein Netz ändern, das Change Studio, den Assistenten (bis zu {ai} Verbrauch). Das geänderte Netz bleibt in der Anwendung: Export, Lieferung und Teilen werden mit der Lizenz freigeschaltet.", "{link}"] },
    ending: { subject: "Ihre GTFS-Express-Testphase endet am {date}", lines: ["Ihre kostenlose Testphase von GTFS Express endet am {date}.", "Ihre Arbeit bleibt erhalten. Um weiterzumachen und das geänderte Netz zu liefern, erwerben Sie die Lizenz online oder fordern Sie über das Angebot ein Angebot an.", "{link}"] },
    ended: { subject: "Ihre GTFS-Express-Testphase ist beendet", lines: ["Ihre kostenlose Testphase von GTFS Express ist beendet.", "Ihre Arbeit wartet auf Sie: Sie bleibt erhalten und wird mit der Lizenz freigegeben, online oder auf Angebot. Das Lesen von Netzen bleibt kostenlos.", "{link}"] },
    open: "GTFS Express öffnen: {url}",
  },
  pt: {
    started: { subject: "O seu teste do GTFS Express começou", lines: ["O seu teste gratuito do GTFS Express começou. Dura até {date}.", "Durante o teste pode experimentar tudo: modificar uma rede, o Change Studio, o assistente (até {ai} de consumo). A rede modificada fica na aplicação: a exportação, a entrega e a partilha abrem com a licença.", "{link}"] },
    ending: { subject: "O seu teste do GTFS Express termina a {date}", lines: ["O seu teste gratuito do GTFS Express termina a {date}.", "O seu trabalho é conservado. Para continuar e entregar a rede modificada, adquira a licença online ou peça um orçamento a partir da oferta.", "{link}"] },
    ended: { subject: "O seu teste do GTFS Express terminou", lines: ["O seu teste gratuito do GTFS Express terminou.", "O seu trabalho espera por si: é conservado e sairá com a licença, online ou mediante orçamento. A leitura de redes continua gratuita.", "{link}"] },
    open: "Abrir o GTFS Express: {url}",
  },
  zh: {
    started: { subject: "您的 GTFS Express 试用已开始", lines: ["您的 GTFS Express 免费试用已开始，有效期至 {date}。", "试用期间您可以体验全部功能：修改线网、Change Studio、智能助手（消耗上限为 {ai}）。修改后的线网保留在应用中：导出、交付和分享需在获得许可后开放。", "{link}"] },
    ending: { subject: "您的 GTFS Express 试用将于 {date} 结束", lines: ["您的 GTFS Express 免费试用将于 {date} 结束。", "您的工作会被保留。如需继续并交付修改后的线网，请在线购买许可，或通过报价页面申请报价。", "{link}"] },
    ended: { subject: "您的 GTFS Express 试用已结束", lines: ["您的 GTFS Express 免费试用已结束。", "您的工作已为您保留：获得许可（在线购买或按报价）后即可导出。浏览线网仍然免费。", "{link}"] },
    open: "打开 GTFS Express：{url}",
  },
  hi: {
    started: { subject: "आपका GTFS Express ट्रायल शुरू हो गया है", lines: ["आपका GTFS Express निःशुल्क ट्रायल शुरू हो गया है। यह {date} तक चलेगा।", "ट्रायल के दौरान आप सब कुछ आज़मा सकते हैं: नेटवर्क में बदलाव, Change Studio, सहायक ({ai} तक के उपयोग की सीमा में)। बदला हुआ नेटवर्क एप्लिकेशन में ही रहता है: एक्सपोर्ट, डिलीवरी और साझा करना लाइसेंस के साथ खुलते हैं।", "{link}"] },
    ending: { subject: "आपका GTFS Express ट्रायल {date} को समाप्त होगा", lines: ["आपका GTFS Express निःशुल्क ट्रायल {date} को समाप्त होगा।", "आपका काम सुरक्षित रखा गया है। आगे बढ़ने और बदला हुआ नेटवर्क डिलीवर करने के लिए ऑनलाइन लाइसेंस लें या ऑफ़र से कोटेशन माँगें।", "{link}"] },
    ended: { subject: "आपका GTFS Express ट्रायल समाप्त हो गया है", lines: ["आपका GTFS Express निःशुल्क ट्रायल समाप्त हो गया है।", "आपका काम आपकी प्रतीक्षा कर रहा है: यह सुरक्षित है और लाइसेंस के साथ (ऑनलाइन या कोटेशन पर) बाहर आएगा। नेटवर्क पढ़ना निःशुल्क रहता है।", "{link}"] },
    open: "GTFS Express खोलें: {url}",
  },
};

/** A date in `language` (« 26 octobre 2026 »), or its ISO day when the runtime knows no such locale. */
const dateIn = (iso, language) => {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  try {
    return new Intl.DateTimeFormat(language, { day: "numeric", month: "long", year: "numeric", timeZone: "Europe/Paris" }).format(d);
  } catch {
    return d.toISOString().slice(0, 10);
  }
};

/** `kind` is "started" | "ending" | "ended"; `aiEur` null names the assistant's envelope without a figure. */
const trialMessage = (kind, { until, aiEur = null, url = null, language = "fr" } = {}) => {
  const code = String(language || "").slice(0, 2).toLowerCase();
  const lang = TRIAL[code] ? code : "en";
  const words = TRIAL[lang];
  const vars = { date: dateIn(until, lang), ai: aiEur ? `${aiEur} €` : "—", link: url ? fill(words.open, { url }) : "" };
  const lines = words[kind].lines.map((l) => fill(l, vars)).filter(Boolean);
  return { subject: fill(words[kind].subject, vars), text: `${lines.join("\n\n")}\n\nGTFS Express` };
};

const quoteRequestMessage = ({ organisation, name, email, phone, seats, message, priceEurYear, account }) => {
  const lines = [
    "Nouvelle demande de devis — licence GTFS Express (modification).",
    "",
    `Organisme : ${organisation}`,
    `Contact : ${name} <${email}>`,
    phone ? `Téléphone : ${phone}` : null,
    seats ? `Nombre d'utilisateurs : ${seats}` : null,
    `Prix affiché : ${priceEurYear} € HT / an`,
    account ? `Compte GTFS Express : ${account}` : "Pas de compte connecté au moment de la demande.",
    "",
    message ? `Message :\n${message}` : "Pas de message.",
    "",
    "Répondez directement à ce courriel pour écrire au demandeur. Une fois le bon de commande reçu, activez la licence du compte depuis l'administration (droits avec date de fin).",
  ].filter((l) => l !== null);
  return { subject: `Demande de devis — ${organisation}`, text: lines.join("\n") };
};

module.exports = { loginCodeMessage, trialMessage, quoteRequestMessage, LANGUAGES: Object.keys(CODE), TRIAL_LANGUAGES: Object.keys(TRIAL) };
