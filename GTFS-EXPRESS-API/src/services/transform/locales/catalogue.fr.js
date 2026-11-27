/**
 * The operators' catalogue in French (i18n.catalogueWords): each operation's title and
 * description (ops), each parameter's label and help (params: by name; opParams: "<type>.<name>"
 * when the word depends on the operation). Kept in step with the Change Studio's catalogue words
 * (transform.op.*, transform.param.*, transform.opParam.* of the web app's translations).
 */
"use strict";

module.exports = {
  ops: {
    build_timetable: {
      title: "Construire la grille d'une ligne d'après le cahier des charges",
      description: "Construit exactement les courses qu'une commande d'offre donne pour une ligne, un sens et un type de jour — premier et dernier départ et fréquence par plage, départs, ou grille complète (arrêts × courses) — sur les itinéraires existants de la ligne, à la place des courses du sens aux dates choisies. Demande tout ce que la commande ne dit pas : l'itinéraire, les temps de parcours (ceux qui existent seulement si la commande le dit), les dates où le sens ne circule pas encore, les autres itinéraires."
    },
    add_rows: {
      title: "Ajouter des enregistrements à une table GTFS",
      description: "Pour les experts : insère des enregistrements dans une table du GTFS ; les formats et les références sont vérifiés."
    },
    add_stop: {
      title: "Desservir un arrêt sur une ligne",
      description: "Ajoute un arrêt existant ou nouveau sur la ligne, là où il allonge le moins le trajet ; les nouveaux tronçons sont chronométrés d'après le GTFS et les arrêts suivants se décalent. Avec une sélection de courses (heures à un arrêt, plage horaire…), seules ces courses le desservent : un collège ou un marché desservi par quelques courses."
    },
    add_trips: {
      title: "Ajouter des départs à une ligne",
      description: "Ajoute des départs à des heures données ou toutes les N minutes ; les temps de parcours sont repris de la course la plus proche. Peut aussi ajouter le retour."
    },
    adjust_running_times: {
      title: "Ajuster les temps de parcours",
      description: "Rend les courses plus rapides ou plus lentes (un pourcentage, des minutes en plus ou un nouveau temps) sur tout le trajet ou un tronçon, pour certains départs ou jours."
    },
    align_connections: {
      title: "Caler une ligne sur une correspondance",
      description: "Décale un peu les courses de la ligne en rabattement pour que les voyageurs attendent quelques minutes (3 à 10 par défaut) au pôle, vers ou depuis l'autre service."
    },
    apply_holiday_rules: {
      title: "Définir les horaires des jours fériés",
      description: "Les jours fériés, les lignes suivent les horaires choisis (dimanche par défaut, samedi, un jour de semaine, ou pas de service)."
    },
    assert: {
      title: "Vérifier une condition (sans rien modifier)",
      description: "Vérifie un fait après les étapes précédentes (une attente maximale, un nombre de courses, un arrêt desservi…) ; s'il n'est pas vrai, le plan ne peut pas être appliqué."
    },
    copy_day_service: {
      title: "Appliquer les horaires d'un autre jour",
      description: "Les lignes suivent les horaires d'un autre jour les jours choisis (par ex. le dimanche comme le samedi), à partir d'une date ou sur une période."
    },
    create_route: {
      title: "Créer une nouvelle ligne",
      description: "Une nouvelle ligne sur des arrêts existants ou nouveaux, avec un départ toutes les N minutes ou des horaires donnés ; les temps de parcours viennent du réseau et le tracé des routes."
    },
    delete_rows: {
      title: "Supprimer des enregistrements (et ce qui en dépend)",
      description: "Pour les experts : supprime les enregistrements d'une table GTFS qui correspondent à une condition et, par défaut, ce qui y fait référence."
    },
    discontinue_route: {
      title: "Supprimer une ligne",
      description: "Retire une ligne entièrement, ou à partir d'une date ; les arrêts qui ne sont plus desservis sont listés (ou supprimés sur demande)."
    },
    extend_route: {
      title: "Prolonger une ligne au-delà de son terminus",
      description: "Ajoute des arrêts au-delà d'un terminus ; les horaires existants sont gardés, les nouveaux tronçons chronométrés d'après le réseau et la destination affichée suit le nouveau terminus."
    },
    extend_validity: {
      title: "Prolonger la validité du GTFS",
      description: "Prolonge le calendrier jusqu'à une nouvelle date de fin ; les services qui vont jusqu'au bout suivent, les services saisonniers non, et les jours fériés des nouvelles dates reçoivent leurs horaires."
    },
    merge_routes: {
      title: "Fusionner des lignes",
      description: "Plusieurs lignes n'en font plus qu'une : leurs courses passent sur la ligne conservée et les autres sont supprimées ; des courses bout à bout peuvent devenir des courses directes."
    },
    merge_stops: {
      title: "Fusionner des arrêts en double",
      description: "Regroupe des arrêts en double en un seul ; tous les horaires et références pointent vers l'arrêt conservé. Au-delà de 150 m d'écart, il faut confirmer."
    },
    rebuild_blocks: {
      title: "Refaire les services des véhicules au plus juste",
      description: "Recompose les services des véhicules pour assurer les horaires avec le moins de véhicules possible, avec battements et trajets à vide entre les courses."
    },
    relocate_stop: {
      title: "Déplacer un arrêt",
      description: "Déplace un arrêt définitivement (nouvelle position, trajets recalculés) ou provisoirement sur certaines dates (un autre arrêt est desservi à la place). Au-delà de 400 m, il faut confirmer."
    },
    remove_day_service: {
      title: "Supprimer le service de certains jours",
      description: "Les lignes ne circulent plus les jours choisis (sur toute la validité ou une période), y compris les jours fériés qui suivaient ces horaires."
    },
    remove_stop: {
      title: "Ne plus desservir un arrêt",
      description: "Retire un arrêt des courses d'une ligne, ou de toutes les lignes qui le desservent ; les autres arrêts gardent leurs horaires par défaut."
    },
    remove_trips: {
      title: "Supprimer des départs",
      description: "Supprime les départs choisis (heures, plage horaire, itinéraire, un sur N, ou tous) aux dates choisies seulement ; les arrêts qui perdent toute desserte sont signalés."
    },
    rename_id: {
      title: "Renommer un identifiant partout",
      description: "Pour les experts : donne un nouvel identifiant à un arrêt, une ligne, une course, un service… et réécrit toutes les tables qui l'utilisent."
    },
    rename_stop: {
      title: "Renommer un arrêt",
      description: "Renomme tous les arrêts du lieu qui portent ce nom, ainsi que les destinations affichées égales à l'ancien nom ; les destinations plus longues et les noms de lignes sont signalés."
    },
    reroute: {
      title: "Modifier l'itinéraire entre deux arrêts",
      description: "Remplace le tronçon entre deux arrêts (conservés) par d'autres arrêts, définitivement ou en déviation temporaire ; les nouveaux tronçons sont chronométrés et le tracé redessiné."
    },
    run_like: {
      title: "Faire circuler les horaires d'un autre jour à certaines dates",
      description: "Aux dates choisies, les lignes suivent les horaires d'un autre type de jour (par ex. horaires du samedi un jour de pont), ou ne circulent pas."
    },
    set_accessibility: {
      title: "Indiquer l'accessibilité des arrêts ou des véhicules",
      description: "Indique si les arrêts et les véhicules sont accessibles en fauteuil roulant (et si les vélos sont admis), aux dates choisies seulement."
    },
    set_dwell: {
      title: "Modifier les temps d'arrêt",
      description: "Fixe combien de temps les véhicules restent à certains arrêts d'une ligne ; les arrêts suivants se décalent d'autant."
    },
    set_fields: {
      title: "Modifier un attribut des courses ou des passages d'une ligne",
      description: "Pose un attribut des courses (accessibilité, vélos, girouette) ou des passages aux arrêts (montée ou descente à la demande ou interdite, horaire indicatif, girouette d'arrêt) sur une ligne, dans un sens, à certains arrêts ou sur un tronçon, pour certaines courses, aux dates choisies seulement."
    },
    set_headway: {
      title: "Changer la fréquence d'une ligne sur une plage horaire",
      description: "Remplace les départs d'une ligne sur une plage horaire par un bus toutes les N minutes, aux dates choisies seulement ; chaque grille (jours d'école, mercredis, vacances…) est refaite à partir de ses propres courses."
    },
    set_interlining: {
      title: "Enchaîner deux lignes (même véhicule)",
      description: "Associe les courses de la ligne A qui finissent à un endroit aux courses de la ligne B qui y partent, pour qu'un même véhicule fasse les deux (et que les voyageurs puissent rester à bord) ; ou coupe ce lien."
    },
    set_route_attributes: {
      title: "Renuméroter, renommer ou changer la couleur de lignes",
      description: "Change le numéro, les noms, les couleurs, le type de véhicule ou l'exploitant d'une ligne — ou tout un tableau de renumérotation d'un coup. Les numéros restent uniques."
    },
    set_span: {
      title: "Changer le premier ou le dernier départ",
      description: "Fixe le premier et/ou le dernier départ d'une ligne par sens et par jour ; des départs sont ajoutés à l'intervalle habituel ou supprimés hors des nouvelles heures."
    },
    set_stop_attributes: {
      title: "Modifier le code, la zone, le quai ou la station d'un arrêt",
      description: "Modifie le code, la zone tarifaire, le quai, la description, la page web, le niveau ou la station d'un arrêt ; le nom, la position et l'accessibilité ont leurs propres opérations."
    },
    set_transfer: {
      title: "Définir une correspondance entre deux arrêts",
      description: "Ajoute, modifie ou supprime une règle de correspondance (recommandée, garantie, temps minimal, impossible, rester à bord) entre deux arrêts ou stations."
    },
    shift_trips: {
      title: "Décaler des départs",
      description: "Décale les départs choisis de N minutes, ou pour qu'une course soit à un arrêt à une heure donnée, sans changer les temps de parcours ; aux dates choisies seulement."
    },
    split_route: {
      title: "Couper une ligne en deux",
      description: "Coupe une ligne à un arrêt : chaque course qui y passe devient deux courses et la seconde partie devient une nouvelle ligne ; une correspondance garantie peut être ajoutée."
    },
    sql: {
      title: "Modifier le GTFS par des instructions SQL",
      description: "Exécute des instructions UPDATE, INSERT ou DELETE (syntaxe SQLite, les fichiers GTFS comme tables) sur la copie de travail, sous le filet du moteur : les enregistrements écrits sont vérifiés (formats, références, courses à deux arrêts horodatés, clés, lignes sans course, rien laissé en suspens), leurs valeurs normalisées, la modification comparée, mesurée par les objectifs et les garanties par défaut, validée et annulable comme toute opération. Pour ce qu'aucune opération du catalogue ne sait dire. Une course modifiée ainsi change à toutes ses dates : une modification à certaines dates passe par une opération datée."
    },
    suspend_service: {
      title: "Interrompre des lignes pendant une période",
      description: "Plus de service sur les lignes pendant une période (travaux, saison, grève…) ; le service de remplacement est noté, pas créé."
    },
    truncate_route: {
      title: "Limiter une ligne à un nouveau terminus",
      description: "Un arrêt devient le terminus et la partie au-delà n'est plus desservie (aux dates ou départs choisis seulement, s'il y en a) ; les arrêts qui perdent toute desserte sont listés."
    },
    update_fares: {
      title: "Modifier les tarifs",
      description: "Modifie les prix (un nouveau prix, un pourcentage, ou un prix par tarif), rend des lignes gratuites, ou crée le premier tarif du GTFS ; les devises sont vérifiées."
    },
    update_rows: {
      title: "Modifier des champs d'enregistrements",
      description: "Pour les experts : modifie des champs des enregistrements d'une table GTFS qui correspondent à une condition ; les valeurs sont vérifiées et le résultat doit rester un GTFS valide."
    }
  },
  params: {
    add_min: {
      label: "Minutes à ajouter",
      description: "Minutes ajoutées au tronçon (négatif pour en retirer), réparties sur ses interstations."
    },
    after: {
      label: "Après l'arrêt",
      description: "Insérer le nouvel arrêt juste après celui-ci (l'autre sens suit)."
    },
    after_midnight: {
      label: "Après minuit ?",
      description: "Oui : les heures avant 6 h sont la nuit suivant le jour de service ; Non : tôt le matin. Demandé seulement si les horaires ne le disent pas."
    },
    agency: {
      label: "Exploitant",
      description: "L'entreprise qui exploite la ligne (nom ou identifiant ; par défaut, la seule du GTFS)."
    },
    all: {
      label: "Tous",
      description: "Oui : s'applique à tout ce qui correspond."
    },
    anchor: {
      label: "Horaire conservé",
      description: "L'horaire qui ne bouge pas : départ (les arrêts suivants se décalent), terminus (les précédents se décalent) ou un arrêt (sonnerie d'école, pôle)."
    },
    at: {
      label: "Arrêt",
      description: "L'arrêt où le changement a lieu."
    },
    at_return: {
      label: "Arrêt de coupure (retour)",
      description: "L'arrêt de coupure du sens qui ne dessert pas le premier (en face, sous un autre nom)."
    },
    at_stop: {
      label: "Arrêt de référence",
      description: "L'arrêt auquel se rapportent les horaires (par défaut, le départ de chaque course)."
    },
    bands: {
      label: "Plages horaires",
      description: "Plusieurs plages à la fois, par ex. 07:00-09:00, 16:30-19:00."
    },
    before: {
      label: "Avant l'arrêt",
      description: "Insérer le nouvel arrêt juste avant celui-ci."
    },
    beyond: {
      label: "Terminus prolongé",
      description: "Le terminus au-delà duquel la ligne est prolongée (par défaut, le plus proche du premier nouvel arrêt)."
    },
    bikes_allowed: {
      label: "Vélos à bord",
      description: "Si les vélos sont admis à bord."
    },
    blocks: {
      label: "Si un service véhicule casse",
      description: "Quand une course modifiée ne tient plus avant la suivante de son service véhicule et que le battement ne l'absorbe pas : décaler les courses suivantes (shift_following) ou sortir la course de son service (unlink). Demandé au besoin ; un enchaînement que le battement absorbe est rechaîné sans question."
    },
    both_ways: {
      label: "Dans les deux sens",
      description: "Oui : crée aussi la règle inverse."
    },
    break: {
      label: "Séparer les deux lignes",
      description: "Oui : les véhicules ne passent plus d'une ligne à l'autre."
    },
    cascade: {
      label: "Mettre à jour ce qui en dépend",
      description: "Si ce qui fait référence aux données modifiées suit le changement."
    },
    changes: {
      label: "Plusieurs lignes à la fois",
      description: "Un tableau de renumérotation : une ligne par entrée avec son nouveau numéro, ses noms ou ses couleurs."
    },
    code: {
      label: "Code de l'arrêt",
      description: "Le numéro que les voyageurs voient à l'arrêt."
    },
    color: {
      label: "Couleur de la ligne",
      description: "Couleur de fond, six chiffres hexadécimaux (par ex. 0055A4)."
    },
    confirm_far: {
      label: "Confirmer malgré la distance",
      description: "Oui : accepter même si les lieux sont éloignés."
    },
    connection_min: {
      label: "Temps de correspondance (min)",
      description: "Minutes entre l'arrivée de la première partie et le départ de la seconde."
    },
    currency: {
      label: "Devise",
      description: "Code ISO (EUR, USD…), vérifié avec les tarifs ; requis pour créer le premier tarif."
    },
    dates: {
      label: "Dates précises",
      description: "Uniquement ces jours de service."
    },
    day: {
      label: "Jour vérifié",
      description: "Semaine, samedi, dimanche, un jour de la semaine ou une date : vérifié sur une date type."
    },
    days: {
      label: "Jours",
      description: "Les jours concernés (semaine, samedi, dimanche, tous les jours…)."
    },
    deadhead_kmh: {
      label: "Vitesse à vide (km/h)",
      description: "Vitesse des trajets à vide entre deux courses, dits « haut-le-pied » (25 km/h par défaut)."
    },
    departures: {
      label: "Départs",
      description: "Les heures de départ de chaque terminus, par type de jour."
    },
    desc: {
      label: "Description",
      description: "Une courte description montrée aux voyageurs (par ex. Ligne scolaire)."
    },
    direction: {
      label: "Sens",
      description: "Aller, retour, les deux (par défaut) ou une destination."
    },
    direction_b: {
      label: "Sens de la ligne B",
      description: "Aller, retour ou les deux (par défaut)."
    },
    drop: {
      label: "Extrémité supprimée",
      description: "Le terminus (ou un arrêt au-delà du nouveau terminus) du côté qui n'est plus desservi."
    },
    effective_date: {
      label: "Date d'effet",
      description: "Quand les nouveaux prix s'appliquent (le GTFS ne date pas les tarifs : publiez-le à ce moment-là)."
    },
    end_date: {
      label: "Nouvelle date de fin",
      description: "Le nouveau dernier jour de validité (après l'actuel)."
    },
    entity: {
      label: "Type d'identifiant",
      description: "Ce que l'identifiant désigne : arrêt, ligne, course, service, tracé, exploitant…"
    },
    event: {
      label: "Horaires donnés en",
      description: "Départs de l'arrêt de référence (par défaut) ou arrivées à cet arrêt (par ex. à une école)."
    },
    every: {
      label: "Une course sur N",
      description: "Sélectionne une course sur N, dans l'ordre des départs (voir le décalage)."
    },
    except: {
      label: "Sauf",
      description: "Dates exclues : une période nommée (vacances scolaires…) ou une liste de dates."
    },
    except_routes: {
      label: "Lignes exclues",
      description: "Ces lignes gardent leurs propres horaires."
    },
    except_rule: {
      label: "Horaires des lignes exclues",
      description: "Les jours fériés, les horaires que suivent les lignes exclues (par défaut, les leurs)."
    },
    expect: {
      label: "Nombre d'enregistrements attendu",
      description: "Combien d'enregistrements doivent correspondre ; sinon l'étape s'arrête (0 la saute si rien ne correspond)."
    },
    factor: {
      label: "Coefficient",
      description: "Temps de parcours × ce coefficient (1,1 = +10 %). Utilisez un seul de : coefficient, minutes à ajouter, nouveau temps."
    },
    fare: {
      label: "Tarif",
      description: "Un tarif existant utilisé par la ligne."
    },
    fare_id: {
      label: "Identifiant du nouveau tarif",
      description: "Par défaut : standard."
    },
    fare_ids: {
      label: "Tarifs à modifier",
      description: "Les tarifs à modifier (leurs identifiants), ou tous."
    },
    fare_media: {
      label: "Support de titre",
      description: "Uniquement les titres vendus sur ce support (carte, appli…)."
    },
    fare_product_ids: {
      label: "Titres de transport",
      description: "Les titres à modifier (leurs identifiants), ou tous."
    },
    fares: {
      label: "Tarifs des lignes fusionnées",
      description: "S'ils diffèrent : garder seulement ceux de la ligne conservée, ou tous."
    },
    feeder: {
      label: "Ligne en rabattement",
      description: "La ligne dont les courses se décalent pour rejoindre l'autre service (et son sens)."
    },
    first: {
      label: "Premier départ",
      description: "Le nouveau premier départ (HH:MM)."
    },
    flip: {
      label: "Lignes à sens inversé",
      description: "Lignes fusionnées dont l'aller et le retour sont inversés (par défaut, déduit de l'ordre des arrêts)."
    },
    follow: {
      label: "Suivre l'itinéraire de la ligne",
      description: "Oui (par défaut) : les courses partielles continuent sur l'itinéraire de la ligne et desservent ses arrêts intermédiaires."
    },
    free: {
      label: "Lignes gratuites",
      description: "Ces lignes deviennent gratuites (tarif à zéro) : une liste, ou toutes."
    },
    from: {
      label: "À partir de (heure)",
      description: "Uniquement les courses qui partent à partir de cette heure (HH:MM)."
    },
    from_date: {
      label: "À partir du",
      description: "Premier jour où le changement s'applique ; avant, les horaires actuels continuent."
    },
    from_day: {
      label: "Horaires copiés",
      description: "Le type de jour dont on copie les horaires."
    },
    from_route: {
      label: "Depuis la ligne",
      description: "Uniquement en arrivant par cette ligne."
    },
    from_stop: {
      label: "Depuis l'arrêt",
      description: "L'arrêt d'où part la règle ou le tronçon."
    },
    from_trip: {
      label: "Depuis la course",
      description: "Uniquement depuis cette course (son identifiant ; nécessaire si les voyageurs restent à bord)."
    },
    guaranteed_transfer: {
      label: "Correspondance garantie",
      description: "Oui : une correspondance garantie entre les deux parties à l'arrêt de coupure."
    },
    headsign: {
      label: "Destination affichée",
      description: "La destination affichée sur le véhicule (par défaut, le terminus)."
    },
    headsign_return: {
      label: "Destination affichée (retour)",
      description: "La destination affichée au retour (par défaut, son terminus)."
    },
    headway_min: {
      label: "Toutes les (minutes)",
      description: "Minutes entre deux départs."
    },
    hold: {
      label: "Le rabattement attend",
      description: "Oui : la ligne en rabattement attend au pôle (seulement si les voyageurs repartent par elle)."
    },
    holiday_service: {
      label: "Service les jours fériés",
      description: "Les jours fériés parmi les dates de la nouvelle ligne : none (pas de service ces jours-là, « hors jours fériés ») ou run (elle circule comme les autres jours). Demandé (holidays_unspecified) quand les dates en contiennent un et qu'aucune période de service ne dit except ou period."
    },
    holiday_weekdays: {
      label: "Jours de semaine de vacances en horaires du samedi",
      description: "Là où le réseau applique ses horaires du samedi du lundi au vendredi (vacances scolaires sur certains réseaux) : weekday les traite comme des jours de semaine pour ce changement, network leur laisse les horaires du samedi. set_headway, add_trips, remove_trips, shift_trips et set_span (et create_route, pour sa propre offre) le demandent quand un changement de semaine rencontre de tels jours sans que la demande le dise ; les autres opérations ne le demandent jamais."
    },
    holiday_rule: {
      label: "Horaires des jours fériés",
      description: "Les horaires appliqués ces jours fériés (par défaut, ceux du dimanche)."
    },
    holidays: {
      label: "Jours fériés des nouvelles dates",
      description: "Les jours fériés, une période du plan ou une liste de dates."
    },
    in_seat: {
      label: "Les voyageurs restent à bord",
      description: "Oui : les voyageurs peuvent rester à bord d'une ligne à l'autre ; Non : ils doivent descendre ; vide : rien n'est publié."
    },
    interline: {
      label: "Les véhicules peuvent changer de ligne",
      description: "Par défaut : oui (un véhicule peut faire plusieurs lignes dans la journée)."
    },
    into: {
      label: "Ligne conservée",
      description: "La ligne dans laquelle les autres fusionnent (par défaut, la première)."
    },
    keep: {
      label: "Conservé",
      description: "Ce qui reste."
    },
    kind: {
      label: "Vérification",
      description: "Le type de vérification : attente maximale, nombre de courses, arrêt desservi, ligne existante, absence de service."
    },
    last: {
      label: "Dernier départ",
      description: "Le nouveau dernier départ (HH:MM ; 00:30 après un service du soir = 24:30)."
    },
    last_date: {
      label: "Dernier jour de circulation",
      description: "Ou : la dernière date où la ligne circule."
    },
    lat: {
      label: "Latitude",
      description: "Nouvelle latitude (avec la longitude)."
    },
    layover_min: {
      label: "Battement (min)",
      description: "Minutes d'attente d'un véhicule entre deux courses."
    },
    layover_pct: {
      label: "Battement (% du temps de parcours)",
      description: "Battement minimal en part du temps de parcours (12 % par défaut)."
    },
    level_id: {
      label: "Niveau",
      description: "Le niveau (étage) de l'arrêt dans une station."
    },
    like: {
      label: "Horaires appliqués",
      description: "Le type de jour dont les horaires s'appliquent à ces dates, ou aucun (pas de service)."
    },
    like_date: {
      label: "Comme le",
      description: "Les horaires tels qu'ils étaient ce jour-là (par ex. ceux des vacances scolaires)."
    },
    lon: {
      label: "Longitude",
      description: "Nouvelle longitude (avec la latitude)."
    },
    long_name: {
      label: "Nom de la ligne",
      description: "Le nom complet de la ligne (par ex. Gare ↔ Hôpital)."
    },
    max: {
      label: "Au plus (courses)",
      description: "Au plus ce nombre de courses par jour."
    },
    max_deadhead_km: {
      label: "Plus long trajet à vide (km)",
      description: "Plus long trajet à vide entre deux courses (15 km par défaut)."
    },
    max_distance_m: {
      label: "Distance maximale (m)",
      description: "Écart maximal pour fusionner sans confirmation (150 m par défaut)."
    },
    max_shift_min: {
      label: "Décalage maximal (min)",
      description: "Décalage maximal d'une course (10 minutes par défaut)."
    },
    max_wait_min: {
      label: "Attente maximale (min)",
      description: "Attente maximale pour relier deux courses en une course directe (10 minutes par défaut)."
    },
    min: {
      label: "Au moins (courses)",
      description: "Au moins ce nombre de courses par jour."
    },
    min_transfer_min: {
      label: "Temps minimal de correspondance (min)",
      description: "Minutes nécessaires pour la correspondance."
    },
    minutes: {
      label: "Minutes",
      description: "Un nombre de minutes."
    },
    mode: {
      label: "Mode",
      description: "La façon d'appliquer le changement."
    },
    name: {
      label: "Nom",
      description: "Le nom."
    },
    near: {
      label: "Arrêt existant au nouvel emplacement",
      description: "Au lieu de coordonnées : un déplacement provisoire dessert alors cet arrêt."
    },
    confirm_before_plan_date: {
      label: "Confirmer la suppression avant la date du plan",
      description: "Arrêter le service jusqu'à la veille de la date de début des autres changements du plan efface l'ancien horaire que le cahier des charges conserve jusque-là : l'étape pose la question ; confirm seulement quand le cahier des charges le dit en toutes lettres."
    },
    one_way_confirmed: {
      label: "Confirmer les arrêts à sens unique",
      description: "Un arrêt listé dans un seul sens alors que les courses de l'autre sens passent tout près sans y marquer d'arrêt est demandé (one_way_stop) : confirm seulement quand le cahier des charges dit que cet arrêt n'est desservi que dans un sens ; sinon le lister dans stops et dans stops_return."
    },
    near_existing: {
      label: "Départ à côté d'un départ existant",
      description: "skip : un départ ajouté à moins de 3 minutes d'un départ que la ligne a déjà dans ce sens est laissé de côté (le départ existant reste) ; keep : les deux sont gardés (un renfort voulu). Demandé quand le cas se présente."
    },
    network: {
      label: "Réseau",
      description: "Un réseau tarifaire existant du GTFS."
    },
    new_long_name: {
      label: "Nom de la nouvelle ligne",
      description: "Par défaut : arrêt de coupure ↔ terminus."
    },
    new_short_name: {
      label: "Numéro de la nouvelle ligne",
      description: "La partie après l'arrêt de coupure (à l'aller) devient cette ligne."
    },
    offset: {
      label: "Laquelle sur N",
      description: "Quelle course de chaque groupe (0 = la première)."
    },
    one_way: {
      label: "Sens unique",
      description: "Oui : pas de retour (une boucle, un service scolaire)."
    },
    parent_station: {
      label: "Station (pôle)",
      description: "La station à laquelle appartient l'arrêt."
    },
    pattern: {
      label: "Itinéraire",
      description: "L'itinéraire habituel (main), un arrêt (courses qui y finissent ou y passent), ou Origine → Terminus."
    },
    patterns: {
      label: "Variantes d'itinéraire",
      description: "Si la plage mélange des itinéraires : garder l'alternance, série sur l'itinéraire principal (les autres gardés), ou itinéraire principal seul."
    },
    regime: {
      label: "Courses horaires ou en fréquence",
      description: "Seulement si un sens a, sur la plage, des courses horaires et des courses en fréquence (frequencies.txt) : reconstruire les courses horaires (scheduled), régler les plages en fréquence (frequencies) ou les deux (both : leurs services s'additionnent)."
    },
    payment_method: {
      label: "Paiement",
      description: "Nouveau tarif : payé à bord ou avant de monter."
    },
    percent: {
      label: "Variation (%)",
      description: "+5, −10…, arrondi au pas d'arrondi."
    },
    on_demand: {
      label: "À la demande",
      description: "Oui : montée et descente sur réservation (pickup_type et drop_off_type 2) ; non : desserte normale."
    },
    period: {
      label: "Période",
      description: "Une période nommée : période scolaire, vacances scolaires, jours fériés, ou une période définie dans le plan."
    },
    permanent: {
      label: "Déplacement définitif",
      description: "Oui : définitif ; Non : provisoire (dates nécessaires)."
    },
    platform_code: {
      label: "Quai",
      description: "L'identifiant du quai (A, 3…)."
    },
    platforms: {
      label: "Quais",
      description: "Comment les quais d'une station sont traités."
    },
    prefix: {
      label: "Préfixe des services véhicules",
      description: "Préfixe des identifiants des nouveaux services véhicules (BLK_ par défaut)."
    },
    price: {
      label: "Nouveau prix",
      description: "Par exemple 2,10 (ou 2,10 €)."
    },
    prices: {
      label: "Un prix par tarif",
      description: "Chaque tarif avec son nouveau prix."
    },
    record_transfers: {
      label: "Enregistrer les correspondances",
      description: "Oui : écrire une correspondance garantie pour chaque paire de courses alignées."
    },
    region: {
      label: "Zone scolaire",
      description: "La zone scolaire ou la région quand la période en dépend (A, B ou C en France)."
    },
    remove: {
      label: "Supprimer la règle",
      description: "Oui : supprimer la règle au lieu de la créer."
    },
    remove_orphan_stops: {
      label: "Supprimer les arrêts plus desservis",
      description: "Oui : les arrêts qui ne sont plus desservis sont supprimés. Par défaut : gardés et listés."
    },
    rename_in_headsigns: {
      label: "Aussi dans les destinations plus longues",
      description: "Réécrire aussi l'ancien nom dans les destinations plus longues (Mairie via Centre)."
    },
    rename_in_routes: {
      label: "Aussi dans les noms de lignes",
      description: "Réécrire aussi l'ancien nom dans le nom des lignes qui desservent l'arrêt."
    },
    replace: {
      label: "Services véhicules de l'exploitant",
      description: "Quand des courses ont déjà les services véhicules de l'exploitant : \"replace\" les redécoupe tous, \"keep\" les conserve et ne crée des services théoriques que pour les courses qui n'en ont pas. Demandé s'il n'est pas précisé."
    },
    replaced_by: {
      label: "Remplacée par",
      description: "La ou les lignes de remplacement, ou un texte libre (noté)."
    },
    repeat: {
      label: "Horaires repris sur les nouvelles dates",
      description: "Seulement quand la dernière semaine du flux a d'autres horaires que les précédentes (une semaine de vacances à la fin) : before reprend les horaires des semaines d'avant, last_week ceux de la dernière semaine. Demandé alors."
    },
    replacement: {
      label: "Service de remplacement",
      description: "Tel que le texte le décrit (noté, pas créé)."
    },
    return_pattern: {
      label: "Itinéraire du retour",
      description: "L'itinéraire du retour quand aucun itinéraire de l'autre sens ne part d'où l'aller se termine."
    },
    rider_category: {
      label: "Catégorie de voyageurs",
      description: "Uniquement les titres de cette catégorie (étudiant, senior…)."
    },
    round_trip_layover_min: {
      label: "Retour après (min)",
      description: "Ajoute aussi le retour, qui part ce nombre de minutes après l'arrivée."
    },
    rounding: {
      label: "Arrondi",
      description: "Pas d'arrondi d'une variation en pourcentage (0,05 par défaut)."
    },
    route: {
      label: "Ligne",
      description: "La ligne (numéro, nom ou identifiant)."
    },
    route_a: {
      label: "Ligne qui se termine",
      description: "La ligne dont les courses finissent où l'autre commence."
    },
    route_b: {
      label: "Ligne qui prend la suite",
      description: "La ligne dont les courses partent où la première se termine."
    },
    routes: {
      label: "Lignes",
      description: "Une ou plusieurs lignes, ou toutes."
    },
    rows: {
      label: "Enregistrements",
      description: "Les enregistrements à ajouter, avec leurs colonnes GTFS."
    },
    rule: {
      label: "Horaires des jours fériés",
      description: "Les horaires appliqués les jours fériés (par défaut, ceux du dimanche)."
    },
    scale_dwells: {
      label: "Ajuster aussi les temps d'arrêt",
      description: "Par défaut non : le temps passé aux arrêts est conservé."
    },
    seconds: {
      label: "Temps d'arrêt (secondes)",
      description: "Combien de temps les véhicules restent à l'arrêt (0 ou plus)."
    },
    segment: {
      label: "Tronçon",
      description: "D'un arrêt à un autre : le tronçon qui change (par défaut, tout le trajet)."
    },
    sequence: {
      label: "Sens de la correspondance",
      description: "Les voyageurs arrivent par la ligne en rabattement et repartent par l'autre service (par défaut), ou l'inverse."
    },
    series: {
      label: "Série de départs",
      description: "Un départ toutes les N minutes à partir de l'heure de début, avant l'heure de fin (non incluse), au lieu de lister les heures."
    },
    service: {
      label: "Offre",
      description: "Pour chaque type de jour : un départ toutes les N minutes entre deux heures (la fin non incluse), dans les deux sens."
    },
    set: {
      label: "Nouvelles valeurs",
      description: "Les colonnes à modifier et leurs nouvelles valeurs (vide efface le champ)."
    },
    set_min: {
      label: "Nouveau temps de parcours (min)",
      description: "Le nouveau temps de parcours du tronçon, arrêts compris."
    },
    short_name: {
      label: "Numéro de ligne",
      description: "Le numéro que voient les voyageurs (unique chez l'exploitant)."
    },
    sort_order: {
      label: "Ordre d'affichage",
      description: "Le rang de la ligne dans les listes (par défaut après les autres)."
    },
    start: {
      label: "Premier départ de la série",
      description: "Par défaut : garder le premier départ existant."
    },
    start_date: {
      label: "Nouvelle date de début",
      description: "Un nouveau premier jour de validité, plus tôt."
    },
    stop: {
      label: "Arrêt",
      description: "L'arrêt (nom ou identifiant)."
    },
    stops: {
      label: "Arrêts",
      description: "Des arrêts, par nom ou identifiant."
    },
    stops_return: {
      label: "Arrêts (retour)",
      description: "Les arrêts du retour dans l'ordre du trajet (par défaut, les mêmes à l'envers)."
    },
    table: {
      label: "Table GTFS",
      description: "La table concernée (stops, routes, trips, stop_times…)."
    },
    target: {
      label: "Cible",
      description: "Un arrêt et une heure : la course est décalée pour y être à cette heure."
    },
    template: {
      label: "Course modèle",
      description: "Une course dont on copie les temps de parcours (par défaut, la plus proche en heure)."
    },
    text_color: {
      label: "Couleur du texte",
      description: "Six chiffres hexadécimaux (par défaut noir ou blanc, le plus lisible)."
    },
    through_at: {
      label: "Continuité à",
      description: "Relier les courses d'une ligne qui finissent à cet arrêt aux courses de l'autre qui y partent."
    },
    timed_connection: {
      label: "Garder une correspondance garantie",
      description: "Quand les lignes sont séparées : enregistrer une correspondance garantie entre elles (oui par défaut)."
    },
    times: {
      label: "Horaires",
      description: "Uniquement les courses qui partent à ces heures (HH:MM, séparées par des virgules)."
    },
    timezone: {
      label: "Fuseau horaire",
      description: "Un fuseau IANA, par ex. Europe/Paris."
    },
    to: {
      label: "Jusqu'à (heure)",
      description: "Uniquement les courses qui partent avant cette heure (HH:MM)."
    },
    to_date: {
      label: "Jusqu'au",
      description: "Dernier jour où le changement s'applique (inclus) ; après, les horaires actuels reprennent."
    },
    to_days: {
      label: "Jours concernés",
      description: "Les types de jour qui reçoivent ces horaires (par ex. le dimanche)."
    },
    to_route: {
      label: "Vers la ligne",
      description: "Uniquement en repartant par cette ligne."
    },
    to_stop: {
      label: "Vers l'arrêt",
      description: "L'arrêt où se termine la règle ou le tronçon."
    },
    to_trip: {
      label: "Vers la course",
      description: "Uniquement vers cette course (son identifiant ; nécessaire si les voyageurs restent à bord)."
    },
    transfer_duration_min: {
      label: "Validité pour correspondance (min)",
      description: "Nouveau tarif : minutes pendant lesquelles un titre reste valable en correspondance."
    },
    transfers: {
      label: "Correspondances autorisées",
      description: "Nouveau tarif : nombre de correspondances permises (illimité par défaut)."
    },
    translations: {
      label: "Traductions",
      description: "Le nouveau nom dans d'autres langues (ou supprimer / garder les anciennes traductions)."
    },
    trips: {
      label: "Courses",
      description: "Des courses par identifiant ou numéro ; S53-S75 est une plage."
    },
    tts_name: {
      label: "Nom prononcé",
      description: "Comment le nom est lu par les annonces sonores."
    },
    type: {
      label: "Type de correspondance",
      description: "Recommandée, garantie, temps minimal, impossible, rester à bord ou descente obligatoire."
    },
    url: {
      label: "Page web",
      description: "Une adresse http(s) avec plus d'informations."
    },
    via: {
      label: "Arrêts du nouveau tracé",
      description: "Dans l'ordre du trajet (existants ou nouveaux) ; aucun = sans arrêt entre les deux."
    },
    via_return: {
      label: "Arrêts du nouveau tracé (retour)",
      description: "Les arrêts de l'autre sens dans l'ordre du trajet (par défaut, les mêmes à l'envers)."
    },
    wait_min: {
      label: "Attente au pôle (min)",
      description: "Attente minimale et maximale acceptable, en minutes (3 à 10 par défaut)."
    },
    change_confirmed: {
      label: "Confirmer le changement d'une course seule",
      description: "Une ou deux courses seules dont le temps de parcours entier est réduit de plus de 30 % sont demandées (single_trip_big_change) : une course qui doit arriver ou partir à une autre heure se déplace plutôt avec shift_trips ; confirm seulement quand le cahier des charges dit que le temps de parcours de cette course change."
    },
    was_min: {
      label: "Temps de parcours actuel (min)",
      description: "Le temps de parcours actuel selon le texte (vérifié avec le GTFS)."
    },
    wheelchair_accessible: {
      label: "Véhicules accessibles en fauteuil roulant",
      description: "Si les véhicules accueillent les fauteuils roulants (inconnu, oui, non)."
    },
    wheelchair_boarding: {
      label: "Arrêts accessibles en fauteuil roulant",
      description: "Si l'on peut monter en fauteuil roulant à ces arrêts (inconnu, oui, non)."
    },
    where: {
      label: "Enregistrements concernés",
      description: "Conditions colonne = valeur ; toutes doivent être vraies."
    },
    whole_feed: {
      label: "Tout le GTFS",
      description: "Confirmer que le changement vaut pour tout le GTFS (le GTFS ne peut pas dater l'identité d'une ligne)."
    },
    with: {
      label: "Service de correspondance",
      description: "Le service qui ne bouge pas (une ligne et son sens), ou les horaires d'un service hors GTFS (un train)."
    },
    zone_id: {
      label: "Zone tarifaire",
      description: "La zone tarifaire de l'arrêt."
    }
  },
  "opParams": {
    "build_timetable.direction": {
      label: "Sens",
      description: "0, 1 ou une destination : un seul sens (une commande d'offre décrit chaque sens)."
    },
    "build_timetable.days": {
      label: "Type de jour",
      description: "Le type de jour de la commande : semaine, samedi, dimanche, tous les jours, ou des jours précis."
    },
    "build_timetable.first": {
      label: "Premier départ",
      description: "Premier départ (HH:MM), avec le dernier départ et les plages."
    },
    "build_timetable.last": {
      label: "Dernier départ",
      description: "Dernier départ (HH:MM) : toujours un départ, même hors de la grille de fréquence."
    },
    "build_timetable.bands": {
      label: "Fréquence par plage",
      description: "[{ from, to, headway_min }] : la fréquence de chaque plage horaire (fin non incluse ; headway_min vide ou none : aucun départ sur cette plage)."
    },
    "build_timetable.times": {
      label: "Départs",
      description: "Les départs eux-mêmes (HH:MM), à la place des plages."
    },
    "build_timetable.timetable": {
      label: "Grille complète",
      description: "{ stops : [noms], trips : [[HH:MM, null ou \"pass\" par arrêt]], numbers? } : chaque course d'une grille complète, à la place des plages (null : aucune heure donnée, placée d'après les temps de parcours ; \"pass\" : la course ne dessert pas cet arrêt)."
    },
    "build_timetable.at_stop": {
      label: "Arrêt de référence",
      description: "L'arrêt où se lisent le premier et le dernier départ, les plages et les départs (par défaut : le premier arrêt de l'itinéraire)."
    },
    "build_timetable.pattern": {
      label: "Itinéraire",
      description: "L'itinéraire suivi : main, « Origine → Terminus » (avec « (n stops) » quand deux ont les mêmes extrémités) ou un terminus. Demandé quand le sens en suit plusieurs."
    },
    "build_timetable.running_times": {
      label: "Temps de parcours",
      description: "existing : chaque nouvelle course roule comme la course existante de l'itinéraire la plus proche en heure. Demandé sauf quand la grille donne une heure à chaque arrêt."
    },
    "build_timetable.others": {
      label: "Autres itinéraires du sens",
      description: "Les courses d'autres itinéraires du sens ces jours-là : replace (la commande donne toute la grille) ou keep (gardées). Demandé quand il y en a."
    },
    "build_timetable.new_dates": {
      label: "Dates sans service",
      description: "Dates de la période où le sens ne circule pas encore (jour férié, type de jour nouveau) : add (la grille y circule), skip (laissées sans service) ou new_days (seulement les jours de la semaine où le sens ne circule jamais dans le jeu de données, les autres — un jour férié — laissés sans service). Demandé quand il y en a."
    },
    "build_timetable.gaps": {
      label: "Entre deux plages",
      description: "Un départ hors de toute plage (la commande n'y donne aucune fréquence) : band_start fait partir le suivant au début de la plage suivante. Demandé sinon."
    },
    "build_timetable.pass_stops": {
      label: "Arrêts non desservis",
      description: "Une course de la grille marque des arrêts qu'elle ne dessert pas (\"pass\") et chaque itinéraire qui la porte s'y arrête : serve la fait rouler quand même sur un tel itinéraire, ces arrêts recevant une heure d'après les temps de parcours. Demandé sinon."
    },
    "build_timetable.band_times": {
      label: "Départs des plages à fréquence",
      description: "Où placer les départs des plages que la grille donne par une fréquence, sans les heures : grid en place un à chaque intervalle depuis le début de la plage, avant sa fin — aucun au début quand un départ circule déjà dans l'intervalle qui précède. Demandé quand la grille a de telles plages."
    },
    "add_stop.keep_arrival": {
      label: "Garder l'heure d'arrivée",
      description: "Oui : les courses gardent leur heure d'arrivée au terminus et partent plus tôt (une course scolaire qui doit toujours arriver à l'heure)."
    },
    "add_stop.blocks": {
      label: "Si un service véhicule casse",
      description: "Quand une course modifiée ne tient plus avant la suivante de son service véhicule et que le battement ne l'absorbe pas : décaler les courses suivantes (shift_following), sortir la course de son service (unlink) ou garder l'heure d'arrivée et partir plus tôt (keep_arrival). Demandé au besoin."
    },
    "add_stop.mode": {
      label: "Arrêts suivants",
      description: "Décaler (par défaut) : les arrêts suivants se décalent du temps en plus ; absorber : ils gardent leurs horaires si possible."
    },
    "add_stop.stop": {
      label: "Arrêt",
      description: "Un arrêt existant (nom ou identifiant), ou un nouvel arrêt avec son nom et sa position."
    },
    "add_trips.headsign": {
      label: "Destination affichée",
      description: "La destination affichée sur les nouveaux départs (par défaut, celle de la course modèle)."
    },
    "add_trips.times": {
      label: "Heures de départ",
      description: "Départs (HH:MM) depuis l'arrêt de référence ; 24:30 = après minuit. Soit des heures, soit une série."
    },
    "align_connections.at": {
      label: "Pôle de correspondance",
      description: "L'arrêt ou la station où les voyageurs changent (ses quais comptent)."
    },
    "assert.from": {
      label: "Début de la plage",
      description: "Début de la plage horaire vérifiée (HH:MM)."
    },
    "assert.minutes": {
      label: "Attente maximale acceptable (min)",
      description: "Pour une vérification d'attente maximale."
    },
    "assert.stop": {
      label: "Arrêt",
      description: "Pour vérifier qu'un arrêt est desservi (une station vaut pour ses quais)."
    },
    "assert.to": {
      label: "Fin de la plage",
      description: "Fin de la plage horaire vérifiée (HH:MM)."
    },
    "copy_day_service.mode": {
      label: "Courses existantes",
      description: "Remplacer (par défaut) : les courses de ces jours disparaissent ; ajouter : elles restent à côté de la copie."
    },
    "create_route.headsign": {
      label: "Destination affichée (aller)",
      description: "La destination affichée sur le véhicule (par défaut, le terminus)."
    },
    "create_route.mode": {
      label: "Type de véhicule",
      description: "Bus, tramway, métro, train, bateau… Requis quand on ne peut pas le déduire."
    },
    "create_route.stops": {
      label: "Arrêts (aller, dans l'ordre)",
      description: "Au moins deux : des arrêts existants par nom ou identifiant, ou de nouveaux avec leur position."
    },
    "delete_rows.cascade": {
      label: "Ce qui y fait référence",
      description: "En cascade (par défaut) : supprimer aussi ce qui y fait référence ; restreindre : refuser si quelque chose y fait référence."
    },
    "discontinue_route.from_date": {
      label: "Premier jour sans la ligne",
      description: "Par défaut : la ligne est supprimée entièrement."
    },
    "extend_route.headsign": {
      label: "Destination affichée",
      description: "Destination des courses vers le nouveau terminus (par défaut, le nom de l'ancien terminus est remplacé par le nouveau)."
    },
    "extend_route.stops": {
      label: "Nouveaux arrêts après le terminus",
      description: "Dans l'ordre ; le dernier devient le nouveau terminus."
    },
    "extend_validity.region": {
      label: "Région",
      description: "La région, quand les jours fériés en dépendent."
    },
    "merge_routes.from_date": {
      label: "Premier jour de la ligne fusionnée",
      description: "Les courses antérieures gardent leur ancienne ligne."
    },
    "merge_routes.mode": {
      label: "Type de véhicule",
      description: "Bus, tramway, métro, train, bateau… Requis quand on ne peut pas le déduire."
    },
    "merge_routes.routes": {
      label: "Lignes à fusionner",
      description: "Au moins deux lignes."
    },
    "merge_routes.short_name": {
      label: "Numéro de la ligne fusionnée",
      description: "Le numéro que voient les voyageurs (unique chez l'exploitant)."
    },
    "merge_stops.confirm_far": {
      label: "Confirmer malgré la distance",
      description: "Oui : fusionner même au-delà de la distance maximale."
    },
    "merge_stops.from_date": {
      label: "Date d'effet",
      description: "Le GTFS ne peut pas dater la fiche d'un arrêt : dans la période de validité, le changement apparaît dès le premier jour."
    },
    "merge_stops.keep": {
      label: "Arrêt conservé",
      description: "L'arrêt qui reste (par défaut, le plus desservi)."
    },
    "merge_stops.stops": {
      label: "Arrêts en double",
      description: "Au moins deux ; un nom désigne tous les arrêts qui le portent."
    },
    "rebuild_blocks.layover_min": {
      label: "Battement (min)",
      description: "Battement minimal à la fin d'une course (5 min par défaut)."
    },
    "relocate_stop.confirm_far": {
      label: "Confirmer malgré la distance",
      description: "Oui : accepter un déplacement de plus de 400 m ou au-delà d'un arrêt voisin."
    },
    "relocate_stop.mode": {
      label: "Arrêts suivants",
      description: "Absorber (par défaut) : les arrêts suivants gardent leurs horaires si possible ; décaler : ils se décalent de la différence."
    },
    "relocate_stop.name": {
      label: "Nom de l'arrêt provisoire",
      description: "Par défaut : le nom de l'arrêt suivi de (provisoire)."
    },
    "relocate_stop.route": {
      label: "Ligne",
      description: "La ligne citée par le texte : distingue les arrêts de même nom ; pour un déplacement provisoire, seules ses courses desservent l'arrêt provisoire."
    },
    "relocate_stop.stop": {
      label: "Arrêt à déplacer",
      description: "Nom ou identifiant ; la ligne et le sens distinguent les deux côtés de la rue."
    },
    "remove_day_service.days": {
      label: "Jours sans service",
      description: "Les types de jour qui perdent le service (par ex. le dimanche)."
    },
    "remove_stop.mode": {
      label: "Arrêts suivants",
      description: "Absorber (par défaut) : les arrêts suivants gardent leurs horaires si possible ; décaler : ils se décalent de la différence."
    },
    "remove_stop.route": {
      label: "Uniquement cette ligne",
      description: "Par défaut : toutes les lignes qui desservent l'arrêt."
    },
    "remove_trips.all": {
      label: "Toutes les courses",
      description: "Oui : toutes les courses de la ligne (et du sens) aux dates choisies, quand rien d'autre ne les sélectionne."
    },
    "rename_id.from": {
      label: "Identifiant actuel",
      description: "L'identifiant actuel (un arrêt ou une ligne peut aussi être désigné par son nom)."
    },
    "rename_id.to": {
      label: "Nouvel identifiant",
      description: "Le nouvel identifiant (il doit être libre)."
    },
    "rename_stop.all": {
      label: "Tous les lieux de ce nom",
      description: "Oui : un nom porté par plusieurs lieux — les modifier tous."
    },
    "rename_stop.cascade": {
      label: "Mettre à jour les destinations affichées",
      description: "Oui (par défaut) : les destinations égales à l'ancien nom prennent le nouveau."
    },
    "rename_stop.from_date": {
      label: "Date d'effet",
      description: "Le GTFS ne peut pas dater la fiche d'un arrêt : dans la période de validité, le changement apparaît dès le premier jour."
    },
    "rename_stop.name": {
      label: "Nouveau nom",
      description: "Le nouveau nom de l'arrêt."
    },
    "rename_stop.platforms": {
      label: "Quais",
      description: "Les quais d'une station : par défaut, ceux qui portent l'ancien nom suivent ; oui : tous prennent le nouveau nom ; non : seulement la station."
    },
    "rename_stop.stop": {
      label: "Arrêt",
      description: "Un identifiant (cet arrêt seul) ou son nom actuel (tous les arrêts de ce lieu)."
    },
    "reroute.from_stop": {
      label: "Dernier arrêt avant le nouveau tracé",
      description: "Conservé ; le nouveau tracé commence après lui."
    },
    "reroute.mode": {
      label: "Arrêts suivants",
      description: "Décaler (par défaut) : les arrêts suivants se décalent du temps en plus ; absorber : ils gardent leurs horaires si possible."
    },
    "reroute.to_stop": {
      label: "Premier arrêt après le nouveau tracé",
      description: "Conservé ; le nouveau tracé se termine avant lui."
    },
    "run_like.days": {
      label: "Seulement ces types de jour",
      description: "Seulement les dates de ces types de jour dans la portée (par ex. la semaine pendant les vacances scolaires)."
    },
    "set_accessibility.all": {
      label: "Tous les lieux de ce nom",
      description: "Oui : un nom porté par plusieurs lieux — les modifier tous."
    },
    "set_accessibility.route": {
      label: "Ligne",
      description: "La ligne dont les véhicules changent."
    },
    "set_dwell.stops": {
      label: "Arrêts",
      description: "Par défaut : tous les arrêts intermédiaires."
    },
    "set_fields.set": {
      label: "Nouvelles valeurs",
      description: "Les attributs à poser et leurs valeurs : codes GTFS ou mots (normal, aucun, à la demande, conducteur ; exact, indicatif ; accessible, non accessible ; admis, non admis)."
    },
    "set_fields.table": {
      label: "Table GTFS",
      description: "stop_times (les passages aux arrêts) ou trips (les courses) ; déduite des attributs sinon."
    },
    "set_fields.route": {
      label: "Ligne",
      description: "La ligne dont les courses changent."
    },
    "set_fields.routes": {
      label: "Lignes",
      description: "Plusieurs lignes recevant le même changement."
    },
    "set_fields.direction": {
      label: "Sens",
      description: "Aller, retour, les deux (par défaut) ou la destination que le document nomme."
    },
    "set_fields.trips": {
      label: "Courses",
      description: "Des courses par identifiant ou numéro, à la place de la sélection d'une ligne."
    },
    "set_fields.stops": {
      label: "Arrêts",
      description: "Les passages à ces arrêts seulement ; sans arrêt ni tronçon, tous les passages des courses."
    },
    "set_fields.from_stop": {
      label: "Depuis l'arrêt",
      description: "Début du tronçon (inclus), dans l'ordre du sens ; seul, jusqu'au terminus."
    },
    "set_fields.to_stop": {
      label: "Vers l'arrêt",
      description: "Fin du tronçon (inclus) ; seul, depuis le départ."
    },
    "set_fields.all": {
      label: "Tous les lieux de ce nom",
      description: "Oui : un nom porté par plusieurs lieux de la ligne — tous."
    },
    "set_fields.days": {
      label: "Jours",
      description: "Seulement les courses de ces jours (par défaut : tous)."
    },
    "set_route_attributes.continuous_pickup": {
      label: "Montée en continu",
      description: "Montée possible entre les arrêts, le long de la ligne : oui (0), non (1), sur réservation (2), auprès du conducteur (3) ; vide efface."
    },
    "set_route_attributes.continuous_drop_off": {
      label: "Descente en continu",
      description: "Descente possible entre les arrêts, le long de la ligne : les mêmes codes."
    },
    "set_route_attributes.network": {
      label: "Réseau tarifaire",
      description: "Le réseau tarifaire de la ligne (networks.txt, par identifiant ou nom) ; vide efface."
    },
    "set_route_attributes.cemv_support": {
      label: "Paiement sans contact",
      description: "Paiement par carte bancaire sans contact à bord : inconnu (0), non (1), oui (2)."
    },
    "set_stop_attributes.access": {
      label: "Accès depuis la rue",
      description: "stop_access : oui (1) ou non (0), l'accès direct à l'arrêt ou au quai depuis la rue."
    },
    "set_headway.from": {
      label: "Début de la plage",
      description: "Début de la plage horaire (HH:MM)."
    },
    "set_headway.to": {
      label: "Fin de la plage",
      description: "Fin de la plage horaire (HH:MM), non incluse."
    },
    "set_interlining.at": {
      label: "Point de jonction",
      description: "Là où la ligne A se termine et la ligne B commence (par défaut, le seul endroit où c'est le cas)."
    },
    "set_interlining.layover_min": {
      label: "Battement entre A et B (min)",
      description: "Minutes minimales et maximales entre l'arrivée de A et le départ de B (0 à 15 par défaut)."
    },
    "set_route_attributes.from_date": {
      label: "Date d'effet",
      description: "Dans la période de validité, confirmez avec « Tout le GTFS » (le GTFS ne peut pas dater l'identité d'une ligne)."
    },
    "set_route_attributes.mode": {
      label: "Type de véhicule",
      description: "Bus, tramway, métro, train, bateau… Requis quand on ne peut pas le déduire."
    },
    "set_route_attributes.short_name": {
      label: "Nouveau numéro",
      description: "Le numéro que voient les voyageurs (unique chez l'exploitant)."
    },
    "set_span.headway_min": {
      label: "Intervalle des départs ajoutés (min)",
      description: "Par défaut : l'intervalle habituel à ce moment de la journée."
    },
    "set_stop_attributes.all": {
      label: "Confirmer pour plusieurs arrêts",
      description: "Oui : la même valeur pour plusieurs arrêts, ou un nom porté par plusieurs lieux."
    },
    "set_stop_attributes.from_date": {
      label: "Date d'effet",
      description: "Le GTFS ne peut pas dater la fiche d'un arrêt : dans la période de validité, le changement apparaît dès le premier jour."
    },
    "set_stop_attributes.stops": {
      label: "Arrêts",
      description: "Plusieurs arrêts qui reçoivent les mêmes valeurs."
    },
    "set_transfer.from_stop": {
      label: "Descente à",
      description: "Là où les voyageurs descendent (un arrêt ou une station)."
    },
    "set_transfer.platforms": {
      label: "Quais",
      description: "Oui : une station vaut pour chacun de ses quais (une règle par paire)."
    },
    "set_transfer.to_stop": {
      label: "Montée à",
      description: "Là où les voyageurs montent."
    },
    "shift_trips.all": {
      label: "Toutes les courses",
      description: "Oui : toutes les courses de la ligne (et du sens) aux dates choisies, quand rien d'autre ne les sélectionne."
    },
    "shift_trips.minutes": {
      label: "Décalage (minutes)",
      description: "Positif = plus tard, négatif = plus tôt. Soit un décalage, soit une cible."
    },
    "split_route.at": {
      label: "Arrêt de coupure",
      description: "L'arrêt desservi par les deux parties."
    },
    "split_route.long_name": {
      label: "Nouveau nom de la première partie",
      description: "Le nom complet de la ligne (par ex. Gare ↔ Hôpital)."
    },
    "sql.expect": {
      label: "Nombre d'enregistrements attendu",
      description: "Combien d'enregistrements les instructions doivent modifier en tout (un nombre ou { min, max }) ; sinon l'étape s'arrête. 0 la saute si rien ne correspond."
    },
    "sql.intent": {
      label: "Ce que fait la modification",
      description: "En quelques mots, dans la langue de la personne : le résumé de l'étape le reprend avec les nombres."
    },
    "sql.statements": {
      label: "Instructions SQL",
      description: "Une ou plusieurs instructions UPDATE / INSERT / DELETE séparées par des points-virgules ; les sous-requêtes peuvent lire toute table (un arrêt par son nom, une ligne par son numéro, les courses d'un service). Pas de SELECT seul, pas de modification du schéma ni de transaction, pas de WITH RECURSIVE."
    },
    "truncate_route.at": {
      label: "Nouveau terminus",
      description: "L'arrêt qui devient le terminus."
    },
    "truncate_route.headsign": {
      label: "Destination affichée",
      description: "Destination des courses vers le nouveau terminus (par défaut, le nom de l'ancien terminus est remplacé par le nouveau)."
    },
    "truncate_route.keep": {
      label: "Extrémité conservée",
      description: "Au lieu de l'extrémité supprimée : celle qui reste (ne circule plus qu'entre A et B → nouveau terminus B, conservé A)."
    },
    "update_fares.except": {
      label: "Tarifs inchangés",
      description: "Tarifs laissés tels quels (quand on modifie tous les tarifs)."
    },
    "update_fares.routes": {
      label: "Lignes du nouveau tarif",
      description: "Une liste de lignes, ou toutes."
    }
  }
};
