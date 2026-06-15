import React, { useState } from "react";
import {
  Container,
  Typography,
  Box,
  Paper,
  Divider,
  Link,
  IconButton,
  ToggleButton,
  ToggleButtonGroup,
  Alert,
  useTheme,
} from "@mui/material";
import ArrowBackIcon from "@mui/icons-material/ArrowBack";
import GavelIcon from "@mui/icons-material/Gavel";
import { useLanguage } from "../contexts/LanguageContext";

const LAST_UPDATED = "2026-06-11";

const CONTENT = {
  fr: {
    title: "Conditions Générales d'Utilisation",
    lastUpdated: "Dernière mise à jour",
    authoritativeNotice:
      "La présente version française est la version qui fait foi. Les versions dans d'autres langues sont fournies à titre indicatif uniquement.",
    contactTitle: "Contact",
    contactBody:
      "Pour toute question relative aux présentes CGU ou au service GTFS Express, contactez-nous via notre site :",
    articles: [
      {
        title: "Article 1 — Objet",
        paragraphs: [
          "Les présentes Conditions Générales d'Utilisation (ci-après « CGU ») définissent les conditions dans lesquelles tout utilisateur peut accéder au service en ligne GTFS Express (ci-après « le Service »), édité par Weyland Binary.",
          "L'accès au Service vaut acceptation pleine et entière des présentes CGU. L'utilisateur qui n'accepte pas tout ou partie des présentes CGU doit cesser immédiatement d'utiliser le Service.",
        ],
      },
      {
        title: "Article 2 — Description du Service",
        paragraphs: ["Le Service permet à l'utilisateur de :"],
        list: [
          "Téléverser et analyser des fichiers GTFS (General Transit Feed Specification) au format ZIP",
          "Visualiser les données de transport public (lignes, arrêts, courses, horaires, calendriers, tracés)",
          "Valider la conformité du flux à la spécification GTFS Schedule et au catalogue de règles MobilityData",
          "Éditer toute entité du flux (création, modification, suppression) en mode édition, avec annulation et rétablissement",
          "Exécuter des requêtes via la Console SQL intégrée, y compris des opérations de modification (INSERT, UPDATE, DELETE) en lot",
          "Réexporter le flux modifié au format ZIP",
          "Sauvegarder l'état d'une session sous forme de fichier projet local (.gtfsproj)",
        ],
      },
      {
        title: "Article 3 — Statut bêta",
        paragraphs: [
          "Le Service est mis à disposition en phase bêta. Certaines fonctionnalités, en particulier le mode édition et la Console SQL, sont accessibles via un code d'accès délivré au cas par cas.",
          "L'utilisateur reconnaît que le Service peut comporter des imperfections, présenter des comportements inattendus, faire l'objet de modifications, d'interruptions ou de retraits sans préavis. Le Service ne doit pas être utilisé en production sans précaution adaptée.",
        ],
      },
      {
        title: "Article 4 — Conditions d'accès",
        paragraphs: [
          "L'accès aux fonctionnalités de consultation, validation et export est ouvert à tout utilisateur disposant d'une connexion internet, sans inscription préalable.",
          "L'accès aux fonctionnalités d'édition (mode édition, Console SQL, import/export de fichiers projet) est conditionné à la saisie d'un code d'accès valide. Weyland Binary se réserve le droit de révoquer un code d'accès à tout moment, notamment en cas d'usage non conforme aux présentes CGU.",
          "L'accès aux fonctionnalités d'assistance par intelligence artificielle est également conditionné à un code d'accès valide, au-delà de l'éventuel quota d'essai gratuit décrit à l'article 9.",
          "L'utilisateur reconnaît disposer des compétences et des moyens techniques nécessaires à l'utilisation du Service, et notamment posséder une connaissance suffisante de la spécification GTFS Schedule.",
        ],
      },
      {
        title: "Article 5 — Limites d'utilisation",
        paragraphs: [
          "Afin de garantir la disponibilité du Service à l'ensemble de ses utilisateurs, les limites suivantes s'appliquent :",
        ],
        list: [
          "Taille maximale par téléversement : 50 Mo",
          "Nombre de téléversements : 20 par heure et par adresse IP",
          "Nombre de requêtes API : 1 000 par heure et par adresse IP",
          "Durée de rétention : les données téléversées sont automatiquement supprimées au plus tard après 2 heures d'inactivité de session",
          "Nombre maximal de lignes affectées par une requête de modification de la Console SQL : 10 000 (10 000 directes ; jusqu'à 200 000 en cascade par contrainte d'intégrité référentielle)",
        ],
      },
      {
        title: "Article 6 — Responsabilités de l'utilisateur",
        paragraphs: [
          "L'utilisateur est seul responsable :",
        ],
        list: [
          "Des données qu'il téléverse et de leur conformité à la législation applicable (notamment droits de propriété intellectuelle et données à caractère personnel)",
          "De la sauvegarde de ses données originales avant tout traitement par le Service. Il appartient à l'utilisateur de conserver une copie de son flux GTFS d'origine ; Weyland Binary ne garantit pas la persistance des données téléversées au-delà de la durée de rétention",
          "De la pertinence et des conséquences des modifications qu'il applique via le mode édition ou la Console SQL. L'utilisation de la Console SQL pour exécuter des requêtes de type INSERT, UPDATE ou DELETE relève de la seule appréciation de l'utilisateur, qui doit relire chaque requête avant exécution",
          "De la vérification du flux exporté avant toute intégration dans un système aval (planificateur d'itinéraires, système d'information voyageurs, etc.). Il appartient à l'utilisateur de tester le flux exporté dans son environnement avant mise en production",
          "De la confidentialité de tout code d'accès qui lui est attribué. Tout usage du Service réalisé au moyen d'un code d'accès est réputé effectué par son titulaire",
        ],
      },
      {
        title: "Article 7 — Propriété intellectuelle",
        paragraphs: [
          "Le Service GTFS Express, son code source, son interface, sa charte graphique, sa documentation et l'ensemble de ses composants logiciels sont la propriété exclusive de Weyland Binary. Toute reproduction, représentation, adaptation ou modification, partielle ou totale, est interdite sans autorisation écrite préalable.",
          "Les données GTFS téléversées par l'utilisateur demeurent sa propriété exclusive. Weyland Binary ne revendique aucun droit sur ces données et ne les exploite à aucune fin commerciale. Elles ne sont transmises à aucun tiers, à la seule exception des traitements techniques strictement nécessaires aux fonctionnalités explicitement déclenchées par l'utilisateur, décrits aux articles 8 (composants tiers) et 9 (assistance par intelligence artificielle).",
        ],
      },
      {
        title: "Article 8 — Marques et composants tiers",
        paragraphs: [
          "GTFS et General Transit Feed Specification sont des marques et spécifications maintenues par MobilityData. Le Service n'est ni édité ni endossé par MobilityData ; il met simplement en œuvre la spécification publiée publiquement.",
          "Le Service utilise des composants tiers, notamment OpenStreetMap (fonds cartographiques), OSRM (calcul d'itinéraires pour le snapping de tracés), Leaflet, ainsi que diverses bibliothèques open-source. Les marques et droits associés demeurent la propriété de leurs détenteurs respectifs. L'utilisation du Service implique le respect des conditions d'utilisation de ces composants tiers.",
          "Lors de l'utilisation de la fonction d'accrochage de tracés (snapping), les coordonnées géographiques des points concernés sont transmises au serveur public OSRM aux seules fins du calcul d'itinéraire. Aucune autre donnée du flux n'est transmise à ce service.",
        ],
      },
      {
        title: "Article 9 — Assistance par intelligence artificielle",
        paragraphs: [
          "Le Service propose des fonctionnalités optionnelles d'assistance par intelligence artificielle : génération de requêtes SQL en langage naturel, assistant conversationnel et propositions de correction d'anomalies de validation.",
          "Lorsque l'utilisateur fait appel à ces fonctionnalités — et uniquement dans ce cas —, sa question, l'historique de la conversation en cours ainsi que des métadonnées et extraits du flux strictement nécessaires au traitement (schéma des tables, statistiques agrégées, codes d'anomalies de validation, identifiants d'agences, extraits de résultats de requêtes) sont transmis à Anthropic, PBC (États-Unis), fournisseur du modèle de langage, pour la seule durée du traitement. Conformément aux conditions applicables aux API d'Anthropic, ces données ne sont pas utilisées pour l'entraînement de ses modèles. Aucune transmission n'a lieu tant que l'utilisateur n'envoie pas de message à l'assistant.",
          "Weyland Binary ne conserve pas le contenu des conversations après traitement ; seules des métadonnées techniques (horodatage, volumétrie, code d'accès haché) sont journalisées à des fins de sécurité et de maîtrise des coûts.",
          "Les contenus générés par l'intelligence artificielle (réponses, requêtes SQL, propositions de correction) sont fournis à titre indicatif et peuvent être inexacts ou incomplets. Aucune modification générée par l'IA n'est appliquée au flux sans prévisualisation et confirmation explicite de l'utilisateur, qui doit relire chaque proposition avant application et revalider son flux après application.",
          "Un quota d'essai gratuit limité peut être proposé sans code d'accès ; au-delà, l'accès aux fonctionnalités d'assistance par IA requiert un code d'accès valide. Weyland Binary se réserve le droit d'ajuster ou de suspendre ces quotas à tout moment.",
        ],
      },
      {
        title: "Article 10 — Données personnelles",
        paragraphs: [
          "Conformément au Règlement Général sur la Protection des Données (RGPD), Weyland Binary informe l'utilisateur que :",
        ],
        list: [
          "Aucune donnée personnelle directement identifiante n'est collectée à l'occasion de l'utilisation du Service",
          "Les fichiers GTFS téléversés sont stockés temporairement (2 heures maximum après dernière activité de session) puis supprimés automatiquement",
          "Aucun cookie de pistage n'est utilisé ; seul un identifiant technique de session (UUID v4 stocké en localStorage) est nécessaire au fonctionnement du Service",
          "L'adresse IP est utilisée uniquement à des fins de limitation de débit et n'est pas conservée durablement",
          "Les codes d'accès attribués pour le mode édition font l'objet d'une journalisation technique (horodatage, code utilisé, action effectuée) à des fins de sécurité et de prévention d'usage abusif. Cette journalisation ne contient aucune donnée personnelle directement identifiante",
        ],
      },
      {
        title: "Article 11 — Limitation de responsabilité",
        paragraphs: [
          "Le Service est fourni « en l'état » (AS IS), sans garantie d'aucune sorte, expresse ou implicite, y compris sans s'y limiter les garanties de qualité marchande, d'adéquation à un usage particulier ou de non-violation.",
          "Dans toute la mesure permise par la loi applicable, Weyland Binary ne saurait être tenue responsable :",
        ],
        list: [
          "Des interruptions temporaires du Service pour maintenance ou pour raisons techniques",
          "De la qualité, de l'exactitude, de la complétude ou de la conformité des données GTFS téléversées par l'utilisateur",
          "De la qualité, de l'exactitude ou de la conformité des données GTFS issues d'une édition réalisée par l'utilisateur, que cette édition soit effectuée via le mode édition ou via la Console SQL",
          "Des conséquences directes ou indirectes de l'intégration d'un flux exporté par le Service dans tout système aval (planificateur d'itinéraires, système d'information voyageurs, billettique, etc.), y compris en cas de dysfonctionnement, perte d'exploitation, atteinte à l'image ou réclamation d'un tiers",
          "De toute perte de données résultant d'un dysfonctionnement, d'une suppression automatique à l'issue de la durée de rétention ou d'une mauvaise manipulation par l'utilisateur",
          "De tout dommage direct ou indirect résultant de l'utilisation, de l'impossibilité d'utiliser ou d'une mauvaise utilisation du Service",
        ],
        paragraphs2: [
          "L'utilisateur reconnaît qu'il lui appartient de tester tout flux exporté dans un environnement dédié avant toute mise en production, et de conserver les sauvegardes nécessaires.",
        ],
      },
      {
        title: "Article 12 — Usages interdits",
        paragraphs: ["L'utilisateur s'engage à ne pas :"],
        list: [
          "Utiliser le Service à des fins illégales, frauduleuses ou contraires aux bonnes mœurs",
          "Tenter de contourner les mécanismes de limitation de débit ou de contrôle d'accès",
          "Téléverser des fichiers malveillants ou contenant des virus, ou exploiter une faille à des fins malveillantes",
          "Utiliser le Service pour saturer les serveurs, perturber les autres utilisateurs ou nuire à la disponibilité du Service",
          "Tenter d'accéder aux données d'autres utilisateurs, au code source du Service ou aux ressources serveur non documentées",
          "Utiliser des moyens automatisés (robots, scripts, scrapers) pour interagir avec le Service au-delà des usages prévus",
          "Réutiliser ou redistribuer un code d'accès qui lui a été attribué",
        ],
      },
      {
        title: "Article 13 — Force majeure",
        paragraphs: [
          "Weyland Binary ne pourra être tenue responsable d'un manquement à ses obligations résultant d'un cas de force majeure tel que défini par la jurisprudence française, incluant notamment les pannes ou interruptions de réseaux de télécommunications, les attaques informatiques, les défaillances d'hébergeurs ou de fournisseurs tiers, les actes de puissance publique et les cas fortuits.",
        ],
      },
      {
        title: "Article 14 — Évolution du Service et des CGU",
        paragraphs: [
          "Weyland Binary se réserve le droit de modifier le Service et les présentes CGU à tout moment. Les modifications prennent effet à compter de leur publication.",
          "Toute utilisation du Service postérieure à une modification des CGU vaut acceptation des CGU modifiées. Il appartient à l'utilisateur de consulter régulièrement la version en vigueur.",
        ],
      },
      {
        title: "Article 15 — Droit applicable et juridiction",
        paragraphs: [
          "Les présentes CGU sont soumises au droit français. En cas de litige relatif à leur formation, leur exécution ou leur interprétation, et à défaut de résolution amiable, les tribunaux français seront seuls compétents.",
        ],
      },
    ],
  },
  en: {
    title: "Terms of Use",
    lastUpdated: "Last updated",
    authoritativeNotice:
      "The French version of these Terms of Use is the authoritative version. Versions in other languages are provided for convenience only.",
    contactTitle: "Contact",
    contactBody:
      "For any question regarding these Terms or the GTFS Express service, please contact us through our website:",
    articles: [
      {
        title: "Article 1 — Purpose",
        paragraphs: [
          "These Terms of Use (hereinafter the \"Terms\") define the conditions under which any user may access the GTFS Express online service (hereinafter the \"Service\"), published by Weyland Binary.",
          "Accessing the Service constitutes full and unconditional acceptance of these Terms. Any user who does not accept all or part of these Terms must immediately cease using the Service.",
        ],
      },
      {
        title: "Article 2 — Service description",
        paragraphs: ["The Service allows the user to:"],
        list: [
          "Upload and analyse GTFS (General Transit Feed Specification) files in ZIP format",
          "Visualise public transit data (routes, stops, trips, schedules, calendars, shapes)",
          "Validate the feed against the GTFS Schedule specification and the MobilityData rule catalogue",
          "Edit any entity in the feed (create, update, delete) in edit mode, with undo and redo",
          "Execute queries through the integrated SQL Console, including modification operations (INSERT, UPDATE, DELETE) in batch",
          "Re-export the modified feed in ZIP format",
          "Save the state of a session as a local project file (.gtfsproj)",
        ],
      },
      {
        title: "Article 3 — Beta status",
        paragraphs: [
          "The Service is provided in beta phase. Certain features, in particular edit mode and the SQL Console, are accessible only via an access code issued on a case-by-case basis.",
          "The user acknowledges that the Service may contain imperfections, exhibit unexpected behaviour, be modified, interrupted or withdrawn without notice. The Service must not be used in production without appropriate precautions.",
        ],
      },
      {
        title: "Article 4 — Access conditions",
        paragraphs: [
          "Access to read, validate and export features is open to any user with an internet connection, without prior registration.",
          "Access to edit features (edit mode, SQL Console, project file import/export) requires a valid access code. Weyland Binary reserves the right to revoke an access code at any time, in particular in case of use that is not compliant with these Terms.",
          "Access to artificial-intelligence assistance features also requires a valid access code, beyond the free-trial quota described in Article 9, where offered.",
          "The user acknowledges having the technical skills and resources required to use the Service, and in particular sufficient knowledge of the GTFS Schedule specification.",
        ],
      },
      {
        title: "Article 5 — Usage limits",
        paragraphs: [
          "In order to ensure availability of the Service to all its users, the following limits apply:",
        ],
        list: [
          "Maximum upload size: 50 MB",
          "Uploads: 20 per hour per IP address",
          "API requests: 1,000 per hour per IP address",
          "Retention period: uploaded data are automatically deleted at the latest after 2 hours of session inactivity",
          "Maximum number of rows affected by a SQL Console mutation query: 10,000 (10,000 direct rows; up to 200,000 through cascading referential integrity constraints)",
        ],
      },
      {
        title: "Article 6 — User responsibilities",
        paragraphs: ["The user is solely responsible for:"],
        list: [
          "The data they upload and its compliance with applicable law (in particular intellectual property rights and personal data regulations)",
          "Backing up their original data before any processing by the Service. The user must keep a copy of their original GTFS feed; Weyland Binary does not guarantee the persistence of uploaded data beyond the retention period",
          "The relevance and consequences of any modifications they apply through edit mode or the SQL Console. Use of the SQL Console to execute INSERT, UPDATE or DELETE queries is at the user's sole discretion, and the user must review every query before execution",
          "Verifying the exported feed before any integration into a downstream system (trip planner, passenger information system, etc.). The user must test the exported feed in their own environment before any production use",
          "The confidentiality of any access code assigned to them. Any use of the Service made with an access code is deemed to have been carried out by its holder",
        ],
      },
      {
        title: "Article 7 — Intellectual property",
        paragraphs: [
          "The GTFS Express Service, its source code, its interface, its visual identity, its documentation and all of its software components are the exclusive property of Weyland Binary. Any reproduction, representation, adaptation or modification, in whole or in part, is prohibited without prior written authorisation.",
          "GTFS data uploaded by the user remain its exclusive property. Weyland Binary claims no rights on these data and does not exploit them for any commercial purpose. They are not transferred to any third party, with the sole exception of the technical processing strictly required by features explicitly triggered by the user, as described in Articles 8 (third-party components) and 9 (artificial-intelligence assistance).",
        ],
      },
      {
        title: "Article 8 — Third-party trademarks and components",
        paragraphs: [
          "GTFS and General Transit Feed Specification are trademarks and specifications maintained by MobilityData. The Service is neither published nor endorsed by MobilityData; it merely implements the publicly available specification.",
          "The Service uses third-party components, including OpenStreetMap (map tiles), OSRM (route computation for shape snapping), Leaflet, and various open-source libraries. Associated trademarks and rights remain the property of their respective owners. Use of the Service implies compliance with the terms of use of those third-party components.",
          "When the shape-snapping feature is used, the geographic coordinates of the relevant points are sent to the public OSRM server for the sole purpose of route computation. No other feed data is transmitted to that service.",
        ],
      },
      {
        title: "Article 9 — Artificial-intelligence assistance",
        paragraphs: [
          "The Service offers optional artificial-intelligence assistance features: natural-language SQL generation, a conversational assistant, and validation-issue repair suggestions.",
          "When — and only when — the user invokes these features, their question, the current conversation history, and the feed metadata and excerpts strictly required for processing (table schema, aggregate statistics, validation rule codes, agency identifiers, query result excerpts) are transmitted to Anthropic, PBC (United States), the language-model provider, for the sole duration of processing. In accordance with the terms applicable to Anthropic's APIs, these data are not used to train its models. No transmission occurs until the user sends a message to the assistant.",
          "Weyland Binary does not retain conversation content after processing; only technical metadata (timestamp, volume, hashed access code) is logged for security and cost-control purposes.",
          "AI-generated content (answers, SQL queries, repair suggestions) is provided for guidance only and may be inaccurate or incomplete. No AI-generated modification is applied to the feed without the user's explicit preview and confirmation; the user must review every suggestion before applying it and re-validate the feed afterwards.",
          "A limited free-trial quota may be offered without an access code; beyond it, access to AI assistance features requires a valid access code. Weyland Binary reserves the right to adjust or suspend these quotas at any time.",
        ],
      },
      {
        title: "Article 10 — Personal data",
        paragraphs: [
          "In accordance with the General Data Protection Regulation (GDPR), Weyland Binary informs the user that:",
        ],
        list: [
          "No directly identifying personal data is collected through use of the Service",
          "Uploaded GTFS files are stored temporarily (maximum 2 hours after last session activity) and then automatically deleted",
          "No tracking cookies are used; only a technical session identifier (UUID v4 stored in localStorage) is required for the Service to operate",
          "IP addresses are used only for rate-limiting purposes and are not retained durably",
          "Access codes assigned for edit mode are subject to technical logging (timestamp, code used, action performed) for security and abuse-prevention purposes. This logging contains no directly identifying personal data",
        ],
      },
      {
        title: "Article 11 — Limitation of liability",
        paragraphs: [
          "The Service is provided \"AS IS\", without warranty of any kind, express or implied, including without limitation the implied warranties of merchantability, fitness for a particular purpose and non-infringement.",
          "To the fullest extent permitted by applicable law, Weyland Binary shall not be held liable for:",
        ],
        list: [
          "Temporary interruptions of the Service for maintenance or technical reasons",
          "The quality, accuracy, completeness or compliance of GTFS data uploaded by the user",
          "The quality, accuracy or compliance of GTFS data resulting from an edit performed by the user, whether through edit mode or through the SQL Console",
          "Any direct or indirect consequence of integrating a feed exported by the Service into any downstream system (trip planner, passenger information system, ticketing, etc.), including in case of malfunction, loss of operations, reputational damage or third-party claim",
          "Any data loss resulting from a malfunction, automatic deletion at the end of the retention period, or user mishandling",
          "Any direct or indirect damage resulting from the use, the inability to use or the misuse of the Service",
        ],
        paragraphs2: [
          "The user acknowledges that it is their responsibility to test any exported feed in a dedicated environment before any production use, and to keep adequate backups.",
        ],
      },
      {
        title: "Article 12 — Prohibited use",
        paragraphs: ["The user agrees not to:"],
        list: [
          "Use the Service for unlawful, fraudulent or unethical purposes",
          "Attempt to bypass rate-limiting or access control mechanisms",
          "Upload malicious files or files containing viruses, or exploit a vulnerability for malicious purposes",
          "Use the Service to overload servers, disrupt other users or harm the availability of the Service",
          "Attempt to access other users' data, the Service's source code or any undocumented server resource",
          "Use automated means (robots, scripts, scrapers) to interact with the Service beyond intended uses",
          "Reuse or redistribute an access code that has been assigned to them",
        ],
      },
      {
        title: "Article 13 — Force majeure",
        paragraphs: [
          "Weyland Binary shall not be held liable for any failure to perform its obligations resulting from a case of force majeure as defined by French case law, including without limitation breakdowns or interruptions of telecommunications networks, cyberattacks, failures of hosting providers or third-party suppliers, acts of public authorities and unforeseeable events.",
        ],
      },
      {
        title: "Article 14 — Changes to the Service and to the Terms",
        paragraphs: [
          "Weyland Binary reserves the right to modify the Service and these Terms at any time. Modifications take effect upon publication.",
          "Any use of the Service after a modification of these Terms constitutes acceptance of the modified Terms. It is the user's responsibility to regularly consult the version in force.",
        ],
      },
      {
        title: "Article 15 — Governing law and jurisdiction",
        paragraphs: [
          "These Terms are governed by French law. In the event of a dispute regarding their formation, performance or interpretation, and failing an amicable resolution, the French courts shall have exclusive jurisdiction.",
        ],
      },
    ],
  },
};

function CGU({ onClose }) {
  const theme = useTheme();
  const isDark = theme.palette.mode === "dark";
  const { language } = useLanguage();
  const [variant, setVariant] = useState(language === "fr" ? "fr" : "en");
  const c = CONTENT[variant];

  const accent = isDark ? "#90caf9" : "#1976d2";
  const textBody = isDark ? "#cbd5e1" : "#475569";
  const muted = isDark ? "#94a3b8" : "#64748b";

  return (
    <Container maxWidth="md" sx={{ py: 4 }}>
      <Box
        sx={{
          mb: 3,
          display: "flex",
          alignItems: "center",
          gap: 2,
          flexWrap: "wrap",
        }}
      >
        <IconButton onClick={onClose} sx={{ color: accent }}>
          <ArrowBackIcon />
        </IconButton>
        <Box sx={{ display: "flex", alignItems: "center", gap: 1, flex: 1 }}>
          <GavelIcon sx={{ fontSize: 32, color: accent }} />
          <Typography variant="h4" component="h1" fontWeight={700}>
            {c.title}
          </Typography>
        </Box>
        <ToggleButtonGroup
          size="small"
          value={variant}
          exclusive
          onChange={(_, v) => v && setVariant(v)}
          aria-label="language variant"
        >
          <ToggleButton value="fr" sx={{ px: 2 }}>
            FR
          </ToggleButton>
          <ToggleButton value="en" sx={{ px: 2 }}>
            EN
          </ToggleButton>
        </ToggleButtonGroup>
      </Box>

      <Paper
        elevation={0}
        sx={{
          p: 4,
          backgroundColor: isDark ? "#1e293b" : "#f8fafc",
          border: `1px solid ${isDark ? "#334155" : "#e2e8f0"}`,
        }}
      >
        <Typography
          variant="caption"
          sx={{ color: muted, display: "block", mb: 2 }}
        >
          {c.lastUpdated} : {LAST_UPDATED} — Weyland Binary
        </Typography>

        {variant === "en" && (
          <Alert
            severity="info"
            icon={false}
            sx={{
              mb: 3,
              backgroundColor: isDark
                ? "rgba(144,202,249,0.08)"
                : "rgba(25,118,210,0.06)",
              color: textBody,
              border: `1px solid ${isDark ? "rgba(144,202,249,0.18)" : "rgba(25,118,210,0.18)"}`,
            }}
          >
            {c.authoritativeNotice}
          </Alert>
        )}

        <Divider sx={{ mb: 3 }} />

        {c.articles.map((article) => (
          <Box key={article.title} sx={{ mb: 4 }}>
            <Typography variant="h6" fontWeight={600} gutterBottom>
              {article.title}
            </Typography>
            {(article.paragraphs || []).map((p, idx) => (
              <Typography
                key={idx}
                variant="body2"
                paragraph
                sx={{ color: textBody }}
              >
                {p}
              </Typography>
            ))}
            {article.list && (
              <Box component="ul" sx={{ pl: 3, color: textBody }}>
                {article.list.map((item, idx) => (
                  <Typography
                    key={idx}
                    component="li"
                    variant="body2"
                    sx={{ mb: 1 }}
                  >
                    {item}
                  </Typography>
                ))}
              </Box>
            )}
            {(article.paragraphs2 || []).map((p, idx) => (
              <Typography
                key={`p2-${idx}`}
                variant="body2"
                paragraph
                sx={{ color: textBody, mt: 1 }}
              >
                {p}
              </Typography>
            ))}
          </Box>
        ))}

        <Divider sx={{ my: 3 }} />

        <Box
          sx={{
            mt: 4,
            p: 3,
            backgroundColor: isDark ? "#0f172a" : "#f1f5f9",
            borderRadius: 2,
          }}
        >
          <Typography variant="h6" fontWeight={600} gutterBottom>
            {c.contactTitle}
          </Typography>
          <Typography variant="body2" sx={{ color: textBody }}>
            {c.contactBody}{" "}
            <Link
              href="https://weylandbinary.com"
              target="_blank"
              rel="noopener noreferrer"
              sx={{
                color: accent,
                textDecoration: "none",
                fontWeight: 500,
                "&:hover": { textDecoration: "underline" },
              }}
            >
              Weyland Binary
            </Link>
          </Typography>
        </Box>
      </Paper>
    </Container>
  );
}

export default CGU;
