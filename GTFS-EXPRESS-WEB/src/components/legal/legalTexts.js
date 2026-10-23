/**
 * The four legal documents of /conditions, in French (authoritative) and English. Every figure and name comes from
 * the server (`legal` of GET /config/features) or from this build: nothing is written here that the server does not
 * apply, and what the operator has not given is said to be missing, never filled with a placeholder.
 *
 * A block is { p: parts } | { list: [parts] } | { facts: [[label, parts | null]] } (null: not given) |
 * { table: { head, rows } }, where parts is a string or an array of strings and links ({ href, label }, or
 * { to, label } for a page of this app).
 */

import { legalPath } from "../../utils/routes";

export const LEGAL_UPDATED = "2026-10-21";

/** Safe defaults while the facts load or when an older server does not send them. */
export function normalizeFacts(raw) {
  const f = raw && typeof raw === "object" ? raw : {};
  const publisher = f.publisher && typeof f.publisher === "object" ? f.publisher : {};
  const pick = (v) => (typeof v === "string" && v.trim() ? v.trim() : null);
  const num = (v) => (Number.isFinite(v) ? v : null);
  const r = f.retention || {};
  const o = f.offer || {};
  const p = f.processors || {};
  return {
    publisher: {
      name: pick(publisher.name),
      status: pick(publisher.status),
      address: pick(publisher.address),
      registration: pick(publisher.registration),
      vat: pick(publisher.vat),
      director: pick(publisher.director),
      email: pick(publisher.email),
      phone: pick(publisher.phone),
    },
    host: pick(f.host),
    missing: Array.isArray(f.missing) ? f.missing : ["name", "address", "registration", "director", "contact", "host"],
    sourceCodeUrl: typeof f.source_code_url === "string" && /^https:\/\//i.test(f.source_code_url) ? f.source_code_url : null,
    retention: {
      sessionHours: num(r.session_hours) ?? 2,
      projectsDays: num(r.projects_days),
      accountProjectsDays: num(r.account_projects_days),
      sharesDays: num(r.shares_days) ?? 90,
      logsDays: num(r.logs_days),
      loginCodeMinutes: num(r.login_code_minutes) ?? 10,
      accountSessionDays: num(r.account_session_days) ?? 30,
      trialRecordYears: num(r.trial_record_years) ?? 3,
      quoteMonths: num(r.quote_months) ?? 12,
    },
    offer: {
      accounts: Boolean(o.accounts),
      paid: Boolean(o.paid),
      price: num(o.price_eur_year),
      priceMonth: num(o.price_eur_month),
      trialDays: num(o.trial_days) ?? 0,
      trialAiDaily: num(o.trial_ai_daily),
      trialAiEur: num(o.trial_ai_eur),
      licenceAiEurMonth: num(o.licence_ai_eur_month),
      licenceAiDaily: num(o.licence_ai_daily),
      licenceAiHourly: num(o.licence_ai_hourly),
      onlinePayment: Boolean(o.online_payment),
    },
    processors: {
      model: p.model && typeof p.model === "object" ? { name: pick(p.model.name), region: pick(p.model.region), outsideEu: Boolean(p.model.outside_eu) } : null,
      mail: p.mail && typeof p.mail === "object" ? { name: pick(p.mail.name) } : null,
      payment: p.payment && typeof p.payment === "object" ? { name: pick(p.payment.name) } : null,
    },
  };
}

const euros = (amount, locale) => new Intl.NumberFormat(locale, { style: "currency", currency: "EUR", maximumFractionDigits: 0 }).format(amount);
const mail = (address) => ({ href: `mailto:${address}`, label: address });
const page = (tab, label) => ({ to: legalPath(tab), label });

// ── French (authoritative)

function french(f, env) {
  const P = f.publisher.name || "l'exploitant de ce serveur";
  const contact = f.publisher.email ? mail(f.publisher.email) : null;
  const write = contact ? ["écrivez à ", contact] : ["utilisez les coordonnées des ", page("mentions-legales", "mentions légales")];
  const r = f.retention;
  const o = f.offer;
  const price = o.price ? `${euros(o.price, "fr-FR")} HT` : null;
  const priceMonth = o.priceMonth ? `${euros(o.priceMonth, "fr-FR")} HT` : null;
  const model = f.processors.model;
  const modelName = model?.name || "le fournisseur du modèle de langage";
  const logs = r.logsDays ? `${r.logsDays} jours` : "sans durée fixée par le serveur";
  const missing = "Non renseigné par l'exploitant de ce serveur";

  const notice = {
    title: "Mentions légales",
    intro: "Conformément à l'article 6-III de la loi n° 2004-575 du 21 juin 2004 pour la confiance dans l'économie numérique (LCEN), voici l'identité de l'éditeur et de l'hébergeur de ce service.",
    articles: [
      {
        id: "editeur",
        title: "Éditeur",
        blocks: [
          {
            facts: [
              ["Nom ou raison sociale", f.publisher.name],
              ["Forme juridique", f.publisher.status],
              ["Siège", f.publisher.address],
              ["Immatriculation", f.publisher.registration],
              ["N° de TVA intracommunautaire", f.publisher.vat],
              ["E-mail", contact ? [contact] : null],
              ["Téléphone", f.publisher.phone],
            ],
          },
        ],
      },
      { id: "directeur", title: "Directeur de la publication", blocks: [{ facts: [["Nom", f.publisher.director]] }] },
      { id: "hebergeur", title: "Hébergeur", blocks: [{ facts: [["Nom, adresse et téléphone", f.host]] }] },
      {
        id: "logiciel",
        title: "Logiciel et code source",
        blocks: [
          {
            p: f.sourceCodeUrl
              ? ["GTFS Express est un logiciel libre distribué sous la licence GNU Affero General Public License, version 3 (AGPL-3.0). Le code source de la version en service est disponible ici : ", { href: f.sourceCodeUrl, label: f.sourceCodeUrl }, "."]
              : "GTFS Express est un logiciel libre distribué sous la licence GNU Affero General Public License, version 3 (AGPL-3.0). Le code source de la version en service est disponible sur demande auprès de l'éditeur.",
          },
        ],
      },
      {
        id: "credits",
        title: "Marques et données de tiers",
        blocks: [
          { p: "GTFS (General Transit Feed Specification) est une spécification maintenue par MobilityData ; ce service n'est ni édité ni approuvé par MobilityData. Le validateur canonique utilisé est celui de MobilityData." },
          { p: `Les fonds de carte reposent sur les données © les contributeurs d'OpenStreetMap (licence ODbL), servies par ${env.tiles}. Les réseaux publics proposés proviennent du Point d'accès national transport.data.gouv.fr, chacun sous sa propre licence.` },
        ],
      },
      {
        id: "signalement",
        title: "Signaler un contenu",
        blocks: [{ p: ["Un réseau partagé par lien est publié par la personne qui l'a partagé. Pour signaler un contenu illicite accessible par un lien de partage, ", ...write, "."] }],
      },
    ],
  };

  const terms = {
    title: "Conditions générales d'utilisation",
    articles: [
      {
        id: "objet",
        title: "1. Objet",
        blocks: [
          { p: ["Les présentes conditions générales d'utilisation (les « CGU ») encadrent l'accès au service en ligne GTFS Express (le « Service ») et son utilisation. Le Service est édité par ", P, " (l'« Éditeur »), identifié dans les ", page("mentions-legales", "mentions légales"), "."] },
          { p: ["Utiliser le Service vaut acceptation des CGU en vigueur. L'achat et l'usage de la licence sont en outre régis par les ", page("licence", "conditions de la licence"), " ; le traitement des données personnelles est décrit dans la ", page("confidentialite", "politique de confidentialité"), "."] },
        ],
      },
      {
        id: "service",
        title: "2. Le Service",
        blocks: [
          { p: "GTFS Express sert à lire, vérifier et faire évoluer des données d'offre de transport public au format GTFS." },
          { p: "Gratuitement et sans compte, vous pouvez :" },
          {
            list: [
              "ouvrir un GTFS (fichier, adresse ou réseau public de votre territoire) et l'explorer : vue d'ensemble, lignes, arrêts, horaires, carte, console SQL en lecture ;",
              "le vérifier avec le validateur canonique de MobilityData et le diagnostic du réseau ;",
              "comparer deux versions, partager une lecture par lien, produire le rapport de cohérence.",
            ],
          },
          { p: "Avec la licence, vous pouvez en outre :" },
          {
            list: [
              "modifier un GTFS : mode édition, console SQL en écriture, corrections proposées par l'assistant ;",
              "appliquer un cahier des charges à un réseau (Change Studio) ;",
              "conserver votre travail en projets versionnés et livrer un GTFS vérifié par le validateur canonique.",
            ],
          },
          { p: ["L'essai gratuit permet de tout essayer, sans récupérer le réseau modifié ; les ", page("licence", "conditions de la licence"), " le précisent."] },
          ...(o.paid ? [] : [{ p: "Sur ce serveur, toutes les fonctions sont actuellement ouvertes sans licence." }]),
        ],
      },
      {
        id: "compte",
        title: "3. Accès et compte",
        blocks: [
          { p: `La lecture ne demande aucun compte. Un compte s'ouvre avec une adresse e-mail : à chaque connexion, un code à six chiffres, valable ${r.loginCodeMinutes} minutes, y est envoyé ; aucun mot de passe n'est créé.` },
          { p: "Le compte est personnel. Vous gardez le contrôle de votre messagerie, ne partagez ni les codes ni votre connexion, et signalez sans délai à l'Éditeur tout usage que vous n'avez pas fait." },
          { p: "L'Éditeur peut suspendre un compte en cas de manquement aux CGU, après vous en avoir informé, sauf urgence (sécurité, abus)." },
        ],
      },
      {
        id: "donnees",
        title: "4. Vos données et leur conservation",
        blocks: [
          { p: "Les fichiers GTFS et les documents que vous déposez restent les vôtres. Le Service les conserve le temps nécessaire :" },
          {
            list: [
              `une copie de travail ouverte hors d'un projet : supprimée après ${r.sessionHours} h sans activité ;`,
              ...(r.projectsDays ? [`un projet ouvert sans compte : conservé ${r.projectsDays} jours après sa dernière modification ;`] : []),
              ...(r.accountProjectsDays ? [`un projet d'un compte : conservé ${r.accountProjectsDays} jours après sa dernière modification ;`] : []),
              `un lien de partage : ${r.sharesDays} jours, puis supprimé.`,
            ],
          },
          { p: "Gardez une copie de vos données d'origine : le Service n'est pas un outil d'archivage." },
        ],
      },
      {
        id: "assistant",
        title: "5. L'assistant",
        blocks: [
          { p: `Les fonctions d'assistance par intelligence artificielle sont facultatives. Quand vous les utilisez, et seulement alors, votre demande, l'échange en cours, les documents de votre cahier des charges et les extraits du réseau utiles à la réponse sont envoyés à ${modelName} pour produire la réponse. Les noms des personnes que le service connaît (le compte, les décideurs et les auteurs d'une acceptation ou d'une modification) et toute adresse e-mail écrite dans le texte en sont retirés avant l'envoi ; un document PDF ou une image part tel quel : n'y laissez pas de données personnelles.` },
          { p: "Les propositions de l'assistant peuvent être inexactes ou incomplètes. Aucune n'est appliquée à votre réseau sans un acte explicite de votre part ; il vous appartient de les relire. Leur usage est plafonné (essai, usage équitable de la licence, budget du serveur)." },
        ],
      },
      {
        id: "engagements",
        title: "6. Vos engagements",
        blocks: [
          { p: "Vous vous engagez à :" },
          {
            list: [
              "disposer des droits nécessaires sur les données et documents que vous déposez, en particulier s'ils contiennent des données personnelles ou des contenus de tiers ;",
              "vérifier tout GTFS produit avec le Service avant de le publier ou de l'intégrer à un système d'information voyageurs, de billettique ou de planification ;",
              "ne pas contourner les limites et les contrôles d'accès, ni solliciter le Service de manière abusive (robots, requêtes massives) ;",
              "ne pas déposer de fichier malveillant ni tenter d'accéder aux données d'autrui ;",
              "ne publier par lien de partage aucun contenu illicite.",
            ],
          },
        ],
      },
      {
        id: "limites",
        title: "7. Limites techniques",
        blocks: [{ p: "Des limites protègent la disponibilité du Service pour tous : taille d'un fichier déposé (50 Mo), nombre de requêtes et de dépôts par adresse IP, nombre de lignes qu'une instruction de la console SQL peut modifier. Une limite atteinte est signalée au moment où elle s'applique." }],
      },
      {
        id: "propriete",
        title: "8. Propriété intellectuelle",
        blocks: [
          { p: ["Le logiciel GTFS Express est un logiciel libre sous licence AGPL-3.0 (voir les ", page("mentions-legales", "mentions légales"), ") ; cette licence régit le code, non le nom ni la présentation du Service, qui restent ceux de l'Éditeur."] },
          { p: "Vos données, ainsi que les GTFS, rapports et livrables que vous produisez avec le Service, sont à vous. L'Éditeur ne s'en sert à aucune autre fin que de vous rendre le Service et ne les cède à personne." },
        ],
      },
      {
        id: "tiers",
        title: "9. Services de tiers",
        blocks: [{ p: ["Le Service s'appuie sur des services de tiers : fonds de carte, calcul d'itinéraires routiers, géocodage et données publiques. Leur disponibilité ne dépend pas de l'Éditeur ; la ", page("confidentialite", "politique de confidentialité"), " dit ce qu'ils reçoivent."] }],
      },
      {
        id: "responsabilite",
        title: "10. Disponibilité et responsabilité",
        blocks: [
          { p: "L'Éditeur met en œuvre des moyens raisonnables pour fournir le Service ; il peut être interrompu pour maintenance ou en cas d'incident. Dans la limite permise par la loi, l'Éditeur n'est pas responsable :" },
          {
            list: [
              "de l'exactitude des données que vous déposez ;",
              "des conséquences de la publication ou de l'intégration d'un GTFS produit avec le Service sans la vérification qui vous incombe ;",
              "des dommages indirects, tels qu'une perte d'exploitation, d'image ou de données non sauvegardées.",
            ],
          },
          { p: ["Pour la licence, la responsabilité de l'Éditeur est encadrée par les ", page("licence", "conditions de la licence"), "."] },
        ],
      },
      {
        id: "fin",
        title: "11. Fin de l'utilisation",
        blocks: [{ p: "Vous pouvez cesser d'utiliser le Service à tout moment. Un compte se supprime depuis « Mes données », qui permet aussi de télécharger vos données." }],
      },
      {
        id: "evolution",
        title: "12. Évolution des CGU",
        blocks: [{ p: "L'Éditeur peut faire évoluer le Service et les CGU ; la date de mise à jour figure en tête. Les CGU applicables sont celles en vigueur au moment de l'utilisation. Une modification n'a pas d'effet sur une période de licence déjà payée." }],
      },
      {
        id: "droit",
        title: "13. Droit applicable",
        blocks: [{ p: "Les CGU sont soumises au droit français. À défaut d'accord amiable, tout litige relève des juridictions françaises compétentes. La version française fait foi." }],
      },
    ],
  };

  const sale = {
    title: "Conditions générales de vente de la licence",
    intro: o.paid ? null : "Aucune licence n'est vendue sur ce serveur pour le moment : toutes ses fonctions y sont ouvertes. Ces conditions s'appliqueront dès l'ouverture de l'offre.",
    articles: [
      {
        id: "champ",
        title: "1. Champ d'application",
        blocks: [
          { p: "Les présentes conditions régissent la vente de la licence GTFS Express par l'Éditeur à tout client professionnel ou public (collectivité, autorité organisatrice de la mobilité, opérateur, bureau d'études : le « Client »). Le Service n'est pas proposé aux consommateurs : le Client déclare agir pour les besoins de son activité professionnelle ou de sa mission." },
          { p: "Elles prévalent sur tout autre document du Client, sauf conditions particulières acceptées par écrit par l'Éditeur. Pour un achat public, les pièces du marché prévalent sur elles." },
        ],
      },
      {
        id: "licence",
        title: "2. La licence",
        blocks: [{ p: ["La licence ouvre, pour un compte, c'est-à-dire une personne nommée, toutes les fonctions de modification décrites dans les ", page("utilisation", "conditions d'utilisation"), " : édition, console SQL en écriture, assistant, Change Studio, projets versionnés et livraison. Elle est personnelle et ne peut être ni partagée ni cédée. La lecture reste gratuite et ouverte à tous."] }],
      },
      {
        id: "prix",
        title: "3. Prix",
        blocks: [
          { p: price ? `Le prix de la licence est de ${price} par compte et par an${priceMonth ? `, ou de ${priceMonth} par compte et par mois, sans engagement et payé en ligne uniquement` : ""}, TVA en sus au taux en vigueur. Le prix applicable est celui affiché lors de la commande ou celui du devis accepté.` : "Le prix de la licence, hors taxes, par compte et par an, est celui affiché lors de la commande ou celui du devis accepté ; la TVA s'y ajoute au taux en vigueur." },
          { p: "L'Éditeur peut modifier son prix pour les périodes à venir : le Client en est informé au moins 30 jours avant le renouvellement et peut résilier avant cette date." },
        ],
      },
      {
        id: "essai",
        title: "4. Essai gratuit",
        blocks: [
          {
            p:
              o.trialDays > 0
                ? `Chaque boîte aux lettres vérifiée bénéficie une fois d'un essai gratuit de ${o.trialDays} jours, sans moyen de paiement${o.trialAiDaily ? ` ; pendant l'essai, l'assistant est limité à ${o.trialAiDaily} demandes par jour` : ""}${o.trialAiEur ? `${o.trialAiDaily ? " et" : " ; pendant l'essai, l'assistant est limité"} à ${o.trialAiEur} € de consommation au total, calculée sur le coût réel de chaque demande` : ""}. Pour l'ouvrir, la personne indique son nom, son organisme et son rôle. Les variantes d'une même adresse (un suffixe « + », les points d'une adresse Gmail) comptent pour une seule, et les adresses jetables ne donnent pas droit à l'essai. L'essai prend fin de lui-même, sans engagement ni facturation.`
                : "Aucun essai gratuit n'est proposé actuellement.",
          },
          ...(o.trialDays > 0
            ? [{ p: "Pendant l'essai, toutes les fonctions s'essaient, mais le réseau modifié ne peut pas être récupéré : l'export du GTFS, le paquet de livraison, la liste des changements d'un brouillon, le lien de partage et l'export CSV de la console SQL s'ouvrent avec la licence. Le travail fait pendant l'essai est conservé selon les durées des conditions d'utilisation et se récupère dès la prise de la licence." }]
            : []),
        ],
      },
      {
        id: "commande",
        title: "5. Commande et paiement",
        blocks: [
          {
            list: [
              ...(o.onlinePayment ? ["En ligne, à l'année ou au mois : par carte bancaire ou prélèvement SEPA, via le prestataire de paiement Stripe. Les données de paiement sont traitées par Stripe et ne sont jamais conservées par l'Éditeur. La licence est ouverte dès la confirmation du paiement."] : []),
              "Sur devis : demandé depuis le Service, le devis est adressé par l'Éditeur ; la licence est ouverte à réception du bon de commande ou du devis signé. La facture est payable par virement ou par mandat administratif, à 30 jours de sa réception.",
            ],
          },
          { p: "Une facture est émise pour chaque période." },
        ],
      },
      {
        id: "retard",
        title: "6. Retard de paiement",
        blocks: [
          { p: "Tout retard de paiement entraîne de plein droit des pénalités au taux appliqué par la Banque centrale européenne à son opération de refinancement la plus récente, majoré de 10 points, et une indemnité forfaitaire pour frais de recouvrement de 40 € (articles L441-10 et D441-5 du code de commerce). Pour les acheteurs publics s'appliquent les intérêts moratoires et l'indemnité forfaitaire prévus par le code de la commande publique." },
          { p: "Après une mise en demeure restée sans effet pendant 15 jours, l'Éditeur peut suspendre la licence." },
        ],
      },
      {
        id: "duree",
        title: "7. Durée et renouvellement",
        blocks: [{ p: "La licence annuelle court un an à compter de son ouverture : payée en ligne, elle se renouvelle chaque année par tacite reconduction, sauf résiliation par le Client depuis son compte avant l'échéance ; ouverte sur devis, elle prend fin à son échéance, sauf nouvelle commande. La licence mensuelle, payée en ligne, se renouvelle chaque mois, sans engagement de durée." }],
      },
      {
        id: "resiliation",
        title: "8. Résiliation",
        blocks: [
          { p: "Le Client peut résilier à tout moment depuis son compte : la résiliation prend effet à la fin de la période payée, sans remboursement de la période en cours." },
          { p: "En cas de manquement grave du Client (fraude, partage du compte, usage abusif), l'Éditeur peut résilier la licence après une mise en demeure restée sans effet pendant 15 jours, ou sans délai en cas d'atteinte à la sécurité du Service." },
        ],
      },
      {
        id: "fin-licence",
        title: "9. Fin de la licence",
        blocks: [{ p: ["À la fin de la licence, les fonctions de modification se ferment et la lecture reste ouverte. Les projets du compte sont conservés comme le disent les ", page("utilisation", "conditions d'utilisation"), " et restent exportables."] }],
      },
      {
        id: "usage-equitable",
        title: "10. Assistant : usage équitable",
        blocks: [
          {
            p:
              o.licenceAiDaily && o.licenceAiHourly
                ? `L'assistant est inclus dans un usage raisonnable : au plus ${o.licenceAiDaily} demandes par jour et ${o.licenceAiHourly} par heure et par compte${o.licenceAiEurMonth ? `, et une consommation de ${o.licenceAiEurMonth} € par mois civil, calculée sur le coût réel de chaque demande` : ""}, dans la limite du budget global du serveur. Une limite atteinte suspend l'assistant jusqu'à la période suivante ; les outils manuels restent disponibles.`
                : "L'assistant est inclus dans un usage raisonnable, dans la limite du budget global du serveur. Une limite atteinte suspend l'assistant jusqu'à la période suivante ; les outils manuels restent disponibles.",
          },
        ],
      },
      {
        id: "assistance",
        title: "11. Assistance et disponibilité",
        blocks: [{ p: "L'assistance est assurée par e-mail, les jours ouvrés ; les demandes des titulaires d'une licence sont traitées en priorité. L'Éditeur met en œuvre des moyens raisonnables pour assurer la disponibilité du Service, sans engagement de niveau de service sauf stipulation contraire du devis." }],
      },
      {
        id: "responsabilite-licence",
        title: "12. Responsabilité",
        blocks: [
          { p: "L'Éditeur est tenu d'une obligation de moyens. Le Client vérifie les données qu'il produit avec le Service avant de les publier ou de les mettre en exploitation ; le validateur canonique et les contrôles du Service aident à cette vérification sans la remplacer." },
          { p: "La responsabilité de l'Éditeur est limitée aux dommages directs prouvés et plafonnée aux sommes payées par le Client au titre de la licence pendant les douze mois précédant le fait générateur ; elle exclut les dommages indirects (perte d'exploitation, de chiffre d'affaires ou d'image, réclamations de tiers). Ces limites ne s'appliquent pas en cas de faute lourde ou dolosive." },
        ],
      },
      {
        id: "donnees-client",
        title: "13. Données du Client",
        blocks: [{ p: ["Les données que le Client dépose restent sa propriété. Pour les données personnelles qu'elles contiendraient, l'Éditeur agit en sous-traitant au sens de l'article 28 du RGPD : il ne les traite que pour fournir le Service, selon les instructions que constituent les présentes conditions ; un accord de traitement des données peut être signé sur demande. La ", page("confidentialite", "politique de confidentialité"), " décrit les autres traitements."] }],
      },
      {
        id: "reversibilite",
        title: "14. Réversibilité",
        blocks: [{ p: "Le Client peut à tout moment exporter ses réseaux au format GTFS et les données de son compte." }],
      },
      {
        id: "droit-licence",
        title: "15. Droit applicable",
        blocks: [{ p: "Les présentes conditions sont soumises au droit français. À défaut d'accord amiable, tout litige relève des tribunaux compétents du ressort du siège de l'Éditeur, sous réserve des règles de compétence impératives applicables aux personnes publiques. La version française fait foi." }],
      },
    ],
  };

  const privacy = {
    title: "Politique de confidentialité",
    articles: [
      {
        id: "responsable",
        title: "1. Responsable du traitement",
        blocks: [{ p: [P, ", éditeur du Service (voir les ", page("mentions-legales", "mentions légales"), "), est responsable des traitements décrits ici. Pour toute question ou pour exercer vos droits, ", ...write, "."] }],
      },
      {
        id: "principes",
        title: "2. Ce que le Service ne fait pas",
        blocks: [
          {
            list: [
              "aucun cookie publicitaire, aucune mesure d'audience ;",
              "aucune revente ni exploitation commerciale de vos données ;",
              "aucun entraînement de modèle sur vos données par l'Éditeur ; les fournisseurs de modèle retenus n'utilisent pas les données de leurs API pour entraîner leurs modèles, selon leurs conditions.",
            ],
          },
        ],
      },
      {
        id: "traitements",
        title: "3. Données, finalités, bases légales et durées",
        blocks: [
          {
            table: {
              head: ["Traitement", "Données", "Base légale", "Durée"],
              rows: [
                ["Lecture et vérification d'un GTFS", "Fichiers déposés (données de transport, en principe sans donnée personnelle), identifiant technique de la copie de travail", "Exécution du service demandé", `${r.sessionHours} h après la dernière activité`],
                ...(r.projectsDays || r.accountProjectsDays
                  ? [["Projets", "Projets, versions, documents du cahier des charges, échanges avec l'assistant ; sans compte, un jeton du navigateur, conservé haché", "Exécution du contrat", [r.projectsDays ? `Sans compte : ${r.projectsDays} jours après la dernière modification` : null, r.accountProjectsDays ? `avec un compte : ${r.accountProjectsDays} jours` : null].filter(Boolean).join(" ; ")]]
                  : []),
                ...(o.accounts
                  ? [
                      ["Compte et connexion", `Adresse e-mail, nom (facultatif), dates de connexion ; codes de connexion conservés hachés (${r.loginCodeMinutes} min) ; connexion maintenue ${r.accountSessionDays} jours, prolongée à chaque usage`, "Exécution du contrat", "Jusqu'à la suppression du compte"],
                      ["Essai gratuit", "Empreinte non réversible de l'adresse e-mail (hachage à clé), pour n'accorder l'essai qu'une fois", "Intérêt légitime (prévenir les abus)", `${r.trialRecordYears} ans après le début de l'essai`],
                      ["Suivi de l'essai", "Nom, organisme et son rôle, réseau concerné et téléphone (facultatifs), langue ; trois messages de service : le début de l'essai, sa fin prochaine, sa fin", "Exécution des mesures précontractuelles prises à la demande de la personne", "Jusqu'à la suppression du compte"],
                      ["Consommation de l'assistant", "Pour chaque demande : date, modèle, fonction utilisée, nombre de jetons et coût ; aucun contenu", "Exécution du contrat (les plafonds de l'essai et de la licence)", "Jusqu'à la suppression du compte, puis conservée sans lien avec la personne"],
                      ["Licence et facturation", "État de la licence, identifiant client chez le prestataire de paiement, factures", "Exécution du contrat ; obligation légale", "Durée de la licence ; pièces comptables 10 ans (article L123-22 du code de commerce)"],
                      ["Demande de devis", "Organisation, nom, e-mail, téléphone, message", "Mesures précontractuelles", `${r.quoteMonths} mois après la demande`],
                    ]
                  : []),
                ["Partage par lien", "Instantané du réseau partagé", "Exécution du service demandé", `${r.sharesDays} jours`],
                ["Assistant", "Demande, échange, documents et extraits du réseau envoyés au fournisseur du modèle ; noms des personnes connues du service et adresses e-mail du texte retirés avant l'envoi (un PDF ou une image part tel quel)", "Exécution du service demandé", "Avec le projet ; chez le fournisseur, selon ses conditions"],
                ["Sécurité et maîtrise des coûts", "Journaux techniques : adresse IP hachée avec une clé secrète, horodatage, actions, volume d'usage de l'assistant ; nombre d'appels au service par jour et par fonction, par compte ; messages envoyés (adresse masquée) ; l'adresse IP en clair ne sert qu'en mémoire, pour limiter le débit", "Intérêt légitime (sécurité, prévention des abus)", logs],
              ],
            },
          },
        ],
      },
      {
        id: "destinataires",
        title: "4. Destinataires et sous-traitants",
        blocks: [
          { p: "Vos données ne sont accessibles qu'à l'Éditeur et, pour ce qui les concerne, à ses sous-traitants :" },
          {
            list: [
              f.host ? `l'hébergement : ${f.host} ;` : ["l'hébergement : l'hébergeur indiqué dans les ", page("mentions-legales", "mentions légales"), " ;"],
              ...(f.processors.mail?.name ? [`l'envoi des e-mails (codes de connexion, demandes de devis) : ${f.processors.mail.name}, France ;`] : []),
              ...(f.processors.payment?.name ? [`le paiement en ligne : ${f.processors.payment.name}, Irlande ;`] : []),
              ...(model?.name ? [`le modèle de langage de l'assistant : ${model.name}${model.region ? ` (région ${model.region})` : ""} ;`] : []),
              `les fonds de carte : votre navigateur les demande directement à ${env.tiles} (et, en secours, à OpenStreetMap), qui reçoit votre adresse IP et la zone affichée ;`,
              "les recherches de communes, d'adresses et de réseaux publics passent par le serveur (geo.api.gouv.fr, transport.data.gouv.fr, OpenStreetMap) : ces services reçoivent le texte recherché, jamais votre adresse IP ;",
              "le tracé d'une forme le long des routes, en mode édition, passe aussi par le serveur : le service de calcul d'itinéraire reçoit les coordonnées des points du tracé, jamais votre adresse IP.",
            ],
          },
        ],
      },
      {
        id: "transferts",
        title: "5. Transferts hors de l'Union européenne",
        blocks: [
          {
            p: model?.outsideEu
              ? `Le fournisseur du modèle (${modelName}) traite les données hors de l'Union européenne : ce transfert est encadré par les garanties prévues au chapitre V du RGPD (décision d'adéquation ou clauses contractuelles types). Les noms des personnes que le service connaît (le compte, les décideurs et les auteurs d'une acceptation ou d'une modification) et toute adresse e-mail écrite dans le texte en sont retirés avant l'envoi ; un document PDF ou une image part tel quel : n'y laissez pas de données personnelles.`
              : model
                ? `Le fournisseur du modèle (${modelName}) traite les données dans l'Union européenne.`
                : "L'assistant n'est pas actif sur ce serveur : aucune donnée n'est envoyée à un fournisseur de modèle.",
          },
          { p: "Les fournisseurs de fonds de carte et de calcul d'itinéraire, appelés par votre navigateur, peuvent être établis hors de l'Union européenne ; ils ne reçoivent ni votre nom ni votre adresse e-mail." },
        ],
      },
      {
        id: "cookies",
        title: "6. Cookies et stockage local",
        blocks: [{ p: "Le Service n'utilise qu'un cookie, strictement nécessaire : celui qui maintient la connexion à votre compte, posé quand vous vous connectez. Il garde aussi dans votre navigateur vos préférences (langue, thème), l'identifiant de votre copie de travail et, sans compte, le jeton de vos projets. Aucun traceur publicitaire ni de mesure d'audience : aucun consentement n'est donc demandé." }],
      },
      {
        id: "droits",
        title: "7. Vos droits",
        blocks: [
          { p: "Vous disposez des droits d'accès, de rectification, d'effacement, de limitation, d'opposition et de portabilité (articles 15 à 21 du RGPD), ainsi que du droit de définir des directives sur le sort de vos données après votre décès." },
          { p: ["Avec un compte, « Mes données » vous permet de télécharger vos données et de supprimer votre compte vous-même. Pour le reste, ", ...write, ". Vous pouvez aussi introduire une réclamation auprès de la CNIL (", { href: "https://www.cnil.fr", label: "www.cnil.fr" }, ")."] },
        ],
      },
      {
        id: "securite",
        title: "8. Sécurité",
        blocks: [{ p: "Connexions chiffrées (HTTPS) ; codes de connexion, jetons et adresses IP conservés sous forme hachée avec une clé secrète ; aucun mot de passe ; accès d'administration restreint ; sauvegardes conservées 30 jours." }],
      },
      {
        id: "evolution-confidentialite",
        title: "9. Évolution",
        blocks: [{ p: "Cette politique suit l'évolution du Service ; la date de mise à jour figure en tête." }],
      },
    ],
  };

  return { "mentions-legales": notice, utilisation: terms, licence: sale, confidentialite: privacy, missingLabel: missing };
}

// ── English (the French version prevails)

function english(f, env) {
  const P = f.publisher.name || "the operator of this server";
  const contact = f.publisher.email ? mail(f.publisher.email) : null;
  const write = contact ? ["write to ", contact] : ["use the contact details in the ", page("mentions-legales", "legal notice")];
  const r = f.retention;
  const o = f.offer;
  const price = o.price ? `${euros(o.price, "en-GB")} excluding VAT` : null;
  const priceMonth = o.priceMonth ? `${euros(o.priceMonth, "en-GB")} excluding VAT` : null;
  const model = f.processors.model;
  const modelName = model?.name || "the language model's provider";
  const logs = r.logsDays ? `${r.logsDays} days` : "no limit set by the server";
  const missing = "Not given by the operator of this server";

  const notice = {
    title: "Legal notice",
    intro: "As required by article 6-III of the French law no. 2004-575 of 21 June 2004 on confidence in the digital economy (LCEN), here are the publisher and the host of this service.",
    articles: [
      {
        id: "editeur",
        title: "Publisher",
        blocks: [
          {
            facts: [
              ["Name or company name", f.publisher.name],
              ["Legal form", f.publisher.status],
              ["Registered office", f.publisher.address],
              ["Registration", f.publisher.registration],
              ["EU VAT number", f.publisher.vat],
              ["E-mail", contact ? [contact] : null],
              ["Phone", f.publisher.phone],
            ],
          },
        ],
      },
      { id: "directeur", title: "Publication director", blocks: [{ facts: [["Name", f.publisher.director]] }] },
      { id: "hebergeur", title: "Host", blocks: [{ facts: [["Name, address and phone", f.host]] }] },
      {
        id: "logiciel",
        title: "Software and source code",
        blocks: [
          {
            p: f.sourceCodeUrl
              ? ["GTFS Express is free software, released under the GNU Affero General Public License, version 3 (AGPL-3.0). The source code of the running version is available here: ", { href: f.sourceCodeUrl, label: f.sourceCodeUrl }, "."]
              : "GTFS Express is free software, released under the GNU Affero General Public License, version 3 (AGPL-3.0). The source code of the running version is available from the publisher on request.",
          },
        ],
      },
      {
        id: "credits",
        title: "Trademarks and third-party data",
        blocks: [
          { p: "GTFS (General Transit Feed Specification) is a specification maintained by MobilityData; this service is neither published nor endorsed by MobilityData. The canonical validator used is MobilityData's." },
          { p: `The basemaps rely on data © OpenStreetMap contributors (ODbL licence), served by ${env.tiles}. The public networks offered come from the French National Access Point transport.data.gouv.fr, each under its own licence.` },
        ],
      },
      {
        id: "signalement",
        title: "Reporting content",
        blocks: [{ p: ["A network shared by link is published by the person who shared it. To report unlawful content reachable through a share link, ", ...write, "."] }],
      },
    ],
  };

  const terms = {
    title: "Terms of use",
    articles: [
      {
        id: "objet",
        title: "1. Purpose",
        blocks: [
          { p: ["These terms of use (the “Terms”) govern access to and use of the online service GTFS Express (the “Service”). The Service is published by ", P, " (the “Publisher”), identified in the ", page("mentions-legales", "legal notice"), "."] },
          { p: ["Using the Service means accepting the Terms in force. Buying and using the licence is also governed by the ", page("licence", "licence's terms"), "; personal data is processed as the ", page("confidentialite", "privacy policy"), " describes."] },
        ],
      },
      {
        id: "service",
        title: "2. The Service",
        blocks: [
          { p: "GTFS Express is used to read, check and change public transport schedule data in the GTFS format." },
          { p: "Free of charge and without an account, you can:" },
          {
            list: [
              "open a GTFS (a file, an address or a public network of your area) and explore it: overview, routes, stops, timetables, map, read-only SQL console;",
              "check it with MobilityData's canonical validator and the network diagnostic;",
              "compare two versions, share a reading by link, produce the coherence report.",
            ],
          },
          { p: "With the licence, you can also:" },
          {
            list: [
              "change a GTFS: edit mode, SQL console with writes, fixes proposed by the assistant;",
              "apply a brief to a network (Change Studio);",
              "keep your work in versioned projects and deliver a GTFS checked by the canonical validator.",
            ],
          },
          { p: ["The free trial lets you try everything, without taking the modified network away; the ", page("licence", "licence's terms"), " say so."] },
          ...(o.paid ? [] : [{ p: "On this server, every feature is currently open without a licence." }]),
        ],
      },
      {
        id: "compte",
        title: "3. Access and account",
        blocks: [
          { p: `Reading needs no account. An account is opened with an e-mail address: at each sign-in, a six-digit code valid for ${r.loginCodeMinutes} minutes is sent to it; no password is created.` },
          { p: "The account is personal. You keep control of your mailbox, share neither the codes nor your sign-in, and tell the Publisher without delay of any use you did not make." },
          { p: "The Publisher may suspend an account that breaches the Terms, after informing you, except in an emergency (security, abuse)." },
        ],
      },
      {
        id: "donnees",
        title: "4. Your data and how long it is kept",
        blocks: [
          { p: "The GTFS files and documents you upload remain yours. The Service keeps them as long as needed:" },
          {
            list: [
              `a working copy open outside a project: deleted after ${r.sessionHours} h without activity;`,
              ...(r.projectsDays ? [`a project opened without an account: kept ${r.projectsDays} days after its last change;`] : []),
              ...(r.accountProjectsDays ? [`a project of an account: kept ${r.accountProjectsDays} days after its last change;`] : []),
              `a share link: ${r.sharesDays} days, then deleted.`,
            ],
          },
          { p: "Keep a copy of your original data: the Service is not an archiving tool." },
        ],
      },
      {
        id: "assistant",
        title: "5. The assistant",
        blocks: [
          { p: `The artificial intelligence features are optional. When you use them, and only then, your request, the current exchange, the documents of your brief and the network extracts the answer needs are sent to ${modelName} to produce the answer. The names of the persons the service knows (the account, the deciders and the authors of an acceptance or a change) and any e-mail address written in the text are removed before sending; a PDF document or an image is sent as it is: leave no personal data in it.` },
          { p: "The assistant's proposals may be inaccurate or incomplete. None is applied to your network without an explicit act of yours; reviewing them is up to you. Their use is capped (trial, the licence's fair use, the server's budget)." },
        ],
      },
      {
        id: "engagements",
        title: "6. Your commitments",
        blocks: [
          { p: "You undertake to:" },
          {
            list: [
              "hold the rights needed on the data and documents you upload, in particular when they contain personal data or third-party content;",
              "check any GTFS produced with the Service before publishing it or loading it into a passenger information, ticketing or planning system;",
              "not circumvent the limits and access controls, nor load the Service abusively (bots, mass requests);",
              "not upload malicious files nor try to reach other people's data;",
              "publish no unlawful content through a share link.",
            ],
          },
        ],
      },
      {
        id: "limites",
        title: "7. Technical limits",
        blocks: [{ p: "Limits keep the Service available to everyone: the size of an uploaded file (50 MB), the number of requests and uploads per IP address, the number of rows one SQL console statement may change. A limit reached is said when it applies." }],
      },
      {
        id: "propriete",
        title: "8. Intellectual property",
        blocks: [
          { p: ["The GTFS Express software is free software under the AGPL-3.0 (see the ", page("mentions-legales", "legal notice"), "); that licence governs the code, not the Service's name or presentation, which remain the Publisher's."] },
          { p: "Your data, and the GTFS, reports and deliverables you produce with the Service, are yours. The Publisher uses them for no other purpose than providing the Service and transfers them to no one." },
        ],
      },
      {
        id: "tiers",
        title: "9. Third-party services",
        blocks: [{ p: ["The Service relies on third-party services: basemaps, road routing, geocoding and public data. Their availability does not depend on the Publisher; the ", page("confidentialite", "privacy policy"), " says what they receive."] }],
      },
      {
        id: "responsabilite",
        title: "10. Availability and liability",
        blocks: [
          { p: "The Publisher uses reasonable means to provide the Service; it may be interrupted for maintenance or in case of an incident. To the extent permitted by law, the Publisher is not liable for:" },
          {
            list: [
              "the accuracy of the data you upload;",
              "the consequences of publishing or loading a GTFS produced with the Service without the check that is yours to make;",
              "indirect damage, such as loss of business, reputation or data not backed up.",
            ],
          },
          { p: ["For the licence, the Publisher's liability is set by the ", page("licence", "licence's terms"), "."] },
        ],
      },
      {
        id: "fin",
        title: "11. Ending your use",
        blocks: [{ p: "You may stop using the Service at any time. An account is deleted from “My data”, which also lets you download your data." }],
      },
      {
        id: "evolution",
        title: "12. Changes to the Terms",
        blocks: [{ p: "The Publisher may change the Service and the Terms; the date of the last update is shown at the top. The applicable Terms are those in force at the time of use. A change has no effect on a licence period already paid." }],
      },
      {
        id: "droit",
        title: "13. Governing law",
        blocks: [{ p: "The Terms are governed by French law. Failing an amicable settlement, any dispute falls within the competent French courts. The French version prevails." }],
      },
    ],
  };

  const sale = {
    title: "Terms of sale of the licence",
    intro: o.paid ? null : "No licence is sold on this server for now: every feature is open on it. These terms will apply once the offer opens.",
    articles: [
      {
        id: "champ",
        title: "1. Scope",
        blocks: [
          { p: "These terms govern the sale of the GTFS Express licence by the Publisher to any professional or public customer (local authority, transport authority, operator, consultancy: the “Customer”). The Service is not offered to consumers: the Customer declares acting for its professional activity or public mission." },
          { p: "They prevail over any other document of the Customer, unless special terms are accepted in writing by the Publisher. For a public purchase, the contract documents prevail over them." },
        ],
      },
      {
        id: "licence",
        title: "2. The licence",
        blocks: [{ p: ["The licence opens, for one account, that is one named person, every change feature described in the ", page("utilisation", "terms of use"), ": editing, SQL console with writes, assistant, Change Studio, versioned projects and delivery. It is personal and may be neither shared nor transferred. Reading stays free and open to everyone."] }],
      },
      {
        id: "prix",
        title: "3. Price",
        blocks: [
          { p: price ? `The licence costs ${price} per account and per year${priceMonth ? `, or ${priceMonth} per account and per month, without commitment and paid online only` : ""}, VAT added at the applicable rate. The applicable price is the one shown when ordering or the one of the accepted quote.` : "The licence's price, excluding VAT, per account and per year, is the one shown when ordering or the one of the accepted quote; VAT is added at the applicable rate." },
          { p: "The Publisher may change its price for future periods: the Customer is told at least 30 days before the renewal and may terminate before that date." },
        ],
      },
      {
        id: "essai",
        title: "4. Free trial",
        blocks: [
          {
            p:
              o.trialDays > 0
                ? `Each verified mailbox gets a free trial of ${o.trialDays} days once, with no means of payment${o.trialAiDaily ? `; during the trial the assistant is limited to ${o.trialAiDaily} requests a day` : ""}${o.trialAiEur ? `${o.trialAiDaily ? " and" : "; during the trial the assistant is limited"} to a use of ${o.trialAiEur} € in all, reckoned on each request's real cost` : ""}. To start it, the person gives their name, their organisation and their role. The spellings of one address (a "+" suffix, the dots of a Gmail address) count as one, and throwaway addresses give no trial. The trial ends by itself, with no commitment and no charge.`
                : "No free trial is offered at present.",
          },
          ...(o.trialDays > 0
            ? [{ p: "During the trial every feature can be tried, but the modified network cannot be taken away: the GTFS export, the delivery package, a draft's list of changes, the share link and the SQL console's CSV export open with the licence. The work done during the trial is kept for the periods of the terms of use and can be taken as soon as the licence is." }]
            : []),
        ],
      },
      {
        id: "commande",
        title: "5. Order and payment",
        blocks: [
          {
            list: [
              ...(o.onlinePayment ? ["Online, yearly or monthly: by card or SEPA direct debit, through the payment provider Stripe. Payment data is processed by Stripe and never kept by the Publisher. The licence opens as soon as the payment is confirmed."] : []),
              "On a quote: asked for from the Service, the quote is sent by the Publisher; the licence opens on receipt of the purchase order or the signed quote. The invoice is payable by bank transfer or administrative mandate, within 30 days of its receipt.",
            ],
          },
          { p: "An invoice is issued for each period." },
        ],
      },
      {
        id: "retard",
        title: "6. Late payment",
        blocks: [
          { p: "Any late payment automatically incurs penalties at the European Central Bank's most recent refinancing rate plus 10 points, and a fixed recovery fee of €40 (articles L441-10 and D441-5 of the French commercial code). For public buyers, the late-payment interest and the fixed fee of the French public procurement code apply." },
          { p: "After a formal notice left without effect for 15 days, the Publisher may suspend the licence." },
        ],
      },
      {
        id: "duree",
        title: "7. Term and renewal",
        blocks: [{ p: "The yearly licence runs for one year from its opening: paid online, it renews every year automatically unless the Customer cancels from its account before the end of the period; opened on a quote, it ends at its term unless ordered again. The monthly licence, paid online, renews every month, with no minimum term." }],
      },
      {
        id: "resiliation",
        title: "8. Termination",
        blocks: [
          { p: "The Customer may cancel at any time from its account: the cancellation takes effect at the end of the paid period, with no refund of the current period." },
          { p: "In case of a serious breach by the Customer (fraud, account sharing, abusive use), the Publisher may terminate the licence after a formal notice left without effect for 15 days, or immediately if the Service's security is at stake." },
        ],
      },
      {
        id: "fin-licence",
        title: "9. End of the licence",
        blocks: [{ p: ["When the licence ends, the change features close and reading stays open. The account's projects are kept as the ", page("utilisation", "terms of use"), " say and can still be exported."] }],
      },
      {
        id: "usage-equitable",
        title: "10. Assistant: fair use",
        blocks: [
          {
            p:
              o.licenceAiDaily && o.licenceAiHourly
                ? `The assistant is included for reasonable use: at most ${o.licenceAiDaily} requests a day and ${o.licenceAiHourly} an hour per account${o.licenceAiEurMonth ? `, and a use of ${o.licenceAiEurMonth} € per calendar month, reckoned on each request's real cost` : ""}, within the server's overall budget. A limit reached pauses the assistant until the next period; the manual tools stay available.`
                : "The assistant is included for reasonable use, within the server's overall budget. A limit reached pauses the assistant until the next period; the manual tools stay available.",
          },
        ],
      },
      {
        id: "assistance",
        title: "11. Support and availability",
        blocks: [{ p: "Support is provided by e-mail on working days; licence holders' requests are handled first. The Publisher uses reasonable means to keep the Service available, with no service level commitment unless the quote says otherwise." }],
      },
      {
        id: "responsabilite-licence",
        title: "12. Liability",
        blocks: [
          { p: "The Publisher has an obligation of means. The Customer checks the data it produces with the Service before publishing it or putting it into service; the canonical validator and the Service's checks help with that check without replacing it." },
          { p: "The Publisher's liability is limited to proven direct damage and capped at the amounts paid by the Customer for the licence in the twelve months before the event giving rise to it; it excludes indirect damage (loss of business, turnover or reputation, third-party claims). These limits do not apply in case of gross negligence or wilful misconduct." },
        ],
      },
      {
        id: "donnees-client",
        title: "13. Customer data",
        blocks: [{ p: ["The data the Customer uploads remains its property. For any personal data it contains, the Publisher acts as a processor under article 28 of the GDPR: it processes it only to provide the Service, following the instructions these terms make up; a data processing agreement can be signed on request. The ", page("confidentialite", "privacy policy"), " describes the other processing."] }],
      },
      {
        id: "reversibilite",
        title: "14. Reversibility",
        blocks: [{ p: "The Customer may at any time export its networks in the GTFS format and the data of its account." }],
      },
      {
        id: "droit-licence",
        title: "15. Governing law",
        blocks: [{ p: "These terms are governed by French law. Failing an amicable settlement, any dispute falls within the competent courts of the Publisher's registered office, subject to the mandatory jurisdiction rules applicable to public bodies. The French version prevails." }],
      },
    ],
  };

  const privacy = {
    title: "Privacy policy",
    articles: [
      {
        id: "responsable",
        title: "1. Controller",
        blocks: [{ p: [P, ", publisher of the Service (see the ", page("mentions-legales", "legal notice"), "), is the controller of the processing described here. For any question or to exercise your rights, ", ...write, "."] }],
      },
      {
        id: "principes",
        title: "2. What the Service does not do",
        blocks: [
          {
            list: [
              "no advertising cookie, no audience measurement;",
              "no sale or commercial use of your data;",
              "no model trained on your data by the Publisher; the model providers chosen do not use their APIs' data to train their models, under their terms.",
            ],
          },
        ],
      },
      {
        id: "traitements",
        title: "3. Data, purposes, legal bases and retention",
        blocks: [
          {
            table: {
              head: ["Processing", "Data", "Legal basis", "Retention"],
              rows: [
                ["Reading and checking a GTFS", "Uploaded files (transport data, normally with no personal data), the working copy's technical id", "Performance of the service asked for", `${r.sessionHours} h after the last activity`],
                ...(r.projectsDays || r.accountProjectsDays
                  ? [["Projects", "Projects, versions, the brief's documents, exchanges with the assistant; without an account, a browser token, kept hashed", "Performance of the contract", [r.projectsDays ? `Without an account: ${r.projectsDays} days after the last change` : null, r.accountProjectsDays ? `with an account: ${r.accountProjectsDays} days` : null].filter(Boolean).join("; ")]]
                  : []),
                ...(o.accounts
                  ? [
                      ["Account and sign-in", `E-mail address, name (optional), sign-in dates; sign-in codes kept hashed (${r.loginCodeMinutes} min); sign-in kept ${r.accountSessionDays} days, extended on each use`, "Performance of the contract", "Until the account is deleted"],
                      ["Free trial", "A non-reversible fingerprint of the e-mail address (keyed hash), so the trial is given once", "Legitimate interest (preventing abuse)", `${r.trialRecordYears} years after the trial began`],
                      ["Following the trial", "Name, organisation and its role, the network concerned and a phone (optional), language; three service messages: the trial's start, its coming end, its end", "Steps taken at the person's request before a contract", "Until the account is deleted"],
                      ["The assistant's use", "For each request: date, model, function used, number of tokens and cost; no content", "Performance of the contract (the trial's and the licence's caps)", "Until the account is deleted, then kept with no link to the person"],
                      ["Licence and invoicing", "The licence's state, the customer id at the payment provider, invoices", "Performance of the contract; legal obligation", "The licence's term; accounting records 10 years (article L123-22 of the French commercial code)"],
                      ["Quote request", "Organisation, name, e-mail, phone, message", "Pre-contractual measures", `${r.quoteMonths} months after the request`],
                    ]
                  : []),
                ["Sharing by link", "A snapshot of the shared network", "Performance of the service asked for", `${r.sharesDays} days`],
                ["Assistant", "Request, exchange, documents and network extracts sent to the model provider; names of the persons the service knows and e-mail addresses in the text removed before sending (a PDF or an image is sent as it is)", "Performance of the service asked for", "With the project; at the provider, under its terms"],
                ["Security and cost control", "Technical logs: the IP address hashed with a secret key, time, actions, the assistant's usage volume; the number of calls to the service per day and per function, per account; messages sent (address masked); the IP address in clear is only used in memory, to limit the rate", "Legitimate interest (security, preventing abuse)", logs],
              ],
            },
          },
        ],
      },
      {
        id: "destinataires",
        title: "4. Recipients and processors",
        blocks: [
          { p: "Your data is only accessible to the Publisher and, for their part, to its processors:" },
          {
            list: [
              f.host ? `hosting: ${f.host};` : ["hosting: the host named in the ", page("mentions-legales", "legal notice"), ";"],
              ...(f.processors.mail?.name ? [`sending e-mails (sign-in codes, quote requests): ${f.processors.mail.name}, France;`] : []),
              ...(f.processors.payment?.name ? [`online payment: ${f.processors.payment.name}, Ireland;`] : []),
              ...(model?.name ? [`the assistant's language model: ${model.name}${model.region ? ` (region ${model.region})` : ""};`] : []),
              `basemaps: your browser asks ${env.tiles} for them directly (and OpenStreetMap as a fallback), which receives your IP address and the area shown;`,
              "searches for towns, addresses and public networks go through the server (geo.api.gouv.fr, transport.data.gouv.fr, OpenStreetMap): those services receive the text searched for, never your IP address;",
              "drawing a shape along the roads, in edit mode, goes through the server too: the routing service receives the coordinates of the shape's points, never your IP address.",
            ],
          },
        ],
      },
      {
        id: "transferts",
        title: "5. Transfers outside the European Union",
        blocks: [
          {
            p: model?.outsideEu
              ? `The model provider (${modelName}) processes the data outside the European Union: the transfer is covered by the safeguards of chapter V of the GDPR (adequacy decision or standard contractual clauses). The names of the persons the service knows (the account, the deciders and the authors of an acceptance or a change) and any e-mail address written in the text are removed before sending; a PDF document or an image is sent as it is: leave no personal data in it.`
              : model
                ? `The model provider (${modelName}) processes the data inside the European Union.`
                : "The assistant is not active on this server: no data is sent to a model provider.",
          },
          { p: "The basemap and routing providers, called by your browser, may be established outside the European Union; they receive neither your name nor your e-mail address." },
        ],
      },
      {
        id: "cookies",
        title: "6. Cookies and local storage",
        blocks: [{ p: "The Service uses one cookie only, strictly necessary: the one that keeps you signed in to your account, set when you sign in. It also keeps in your browser your preferences (language, theme), the id of your working copy and, without an account, the token of your projects. No advertising or audience tracker: no consent is therefore asked for." }],
      },
      {
        id: "droits",
        title: "7. Your rights",
        blocks: [
          { p: "You have the rights of access, rectification, erasure, restriction, objection and portability (articles 15 to 21 of the GDPR), and the right to set directives on your data after your death." },
          { p: ["With an account, “My data” lets you download your data and delete your account yourself. For anything else, ", ...write, ". You may also lodge a complaint with the CNIL, the French data protection authority (", { href: "https://www.cnil.fr", label: "www.cnil.fr" }, ")."] },
        ],
      },
      {
        id: "securite",
        title: "8. Security",
        blocks: [{ p: "Encrypted connections (HTTPS); sign-in codes, tokens and IP addresses kept hashed with a secret key; no password; restricted administration access; backups kept 30 days." }],
      },
      {
        id: "evolution-confidentialite",
        title: "9. Changes",
        blocks: [{ p: "This policy follows the Service's changes; the date of the last update is shown at the top." }],
      },
    ],
  };

  return { "mentions-legales": notice, utilisation: terms, licence: sale, confidentialite: privacy, missingLabel: missing };
}

// `env`: { tiles }, this build's basemap provider.
export function legalDocuments(variant, rawFacts, env) {
  const f = normalizeFacts(rawFacts);
  const e = { tiles: env?.tiles || "OpenFreeMap" };
  return variant === "fr" ? french(f, e) : english(f, e);
}
