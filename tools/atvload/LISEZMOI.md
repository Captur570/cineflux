# ATVLoad — tes apps tvOS sur Apple TV, depuis Windows, sans payer

Installe une IPA tvOS sur ton Apple TV avec un **Apple ID gratuit**, par le réseau, et la renouvelle toute seule avant l'expiration des 7 jours. C'est l'équivalent Windows d'atvloadly, qui ne tourne que sous Linux.

Le moteur est **plumesign** (projet open source PlumeImpactor, variante de bitxeno, licence MIT). ATVLoad le pilote : détection de l'Apple TV, mémoire des apps, renouvellement automatique.

## Le plus simple : ATVLoad.exe

Télécharge **ATVLoad.exe** (release « atv-tools » du dépôt) et double-clique dessus. Rien d'autre à installer.

- Au premier lancement, Windows peut afficher « Windows a protégé votre ordinateur » : *Informations complémentaires › Exécuter quand même* (l'exe n'est pas signé).
- Si Windows demande d'autoriser ATVLoad sur le réseau : **accepte pour les réseaux privés** (c'est ainsi qu'il trouve l'Apple TV).
- La fenêtre guide les trois étapes (moteur, appairage, Apple ID), puis : glisse une IPA tvOS dans la fenêtre, ou installe ShippoTV en un clic. Chaque app affiche les jours qui lui restent ; « Renouvellement auto » (en haut) s'occupe du reste.
- Elle partage tout avec la ligne de commande ci-dessous (même dossier, même compte, mêmes apps).

## En ligne de commande (Python)

### Installation (une fois)

1. Installe **Python 3** (python.org, coche « Add Python to PATH »).
2. Mets `atvload.py` et `atvload.bat` dans un dossier, ouvre un terminal dans ce dossier, puis :
   ```
   atvload setup
   ```
   Ça installe le module `zeroconf` et télécharge `plumesign.exe`.
3. Si Windows demande d'autoriser Python sur le réseau : **accepte pour les réseaux privés**. Ton réseau domestique doit être en profil « Privé ».

### Première utilisation

```
atvload pair                 (Apple TV : Réglages > Télécommandes et appareils > Application et appareils distants, puis code PIN)
atvload login                (ton Apple ID ; code de validation si demandé)
atvload install HelloTV.ipa  (l'app de test)
atvload schedule             (renouvellement automatique quotidien)
```

**Conseil :** utilise un Apple ID secondaire créé pour ça, pas ton compte principal.

### Au quotidien

- `atvload install MonApp.ipa` : installe ou met à jour une app.
- `atvload list` : apps installées et date d'expiration.
- `atvload refresh` : renouvelle maintenant les apps qui expirent dans moins de 3 jours (`--all` pour tout).

La tâche planifiée tourne chaque jour à midi, et au démarrage si le PC était éteint. Elle ne renouvelle que ce qui en a besoin. Le PC doit être allumé et l'Apple TV sur le même réseau. En cas d'échec à moins de 36 h de l'expiration, une fenêtre te prévient.

## Limites du compte gratuit (règles d'Apple)

- L'app expire **7 jours** après la dernière signature, d'où le renouvellement.
- **3 apps** actives maximum par appareil, et 10 identifiants d'app créés par semaine.
- Pas de notifications push, iCloud ni achats intégrés.

## Identification auprès d'Apple

Sans Mac, Apple exige une « identité de machine » (anisette), fournie par un serveur public. Depuis mi-octobre 2026, Apple refuse l'ancienne identité « Android » (erreur 503). ATVLoad choisit donc automatiquement un serveur qui émule un PC Windows avec iTunes, en commençant par `ani.jkcoxson.com`, le serveur utilisé par iloader.

## Dépannage
- **Erreur 503** : Apple refuse l'identité de machine ou bloque après trop d'essais. Mets ATVLoad à jour (`atvload setup`) et ne fais pas plus de 2-3 tentatives par heure.

- **Rien n'est trouvé** : vérifie que l'Apple TV est allumée et sur le même réseau, que le réseau est en profil « Privé », et que le pare-feu autorise Python.
- **« Session expirée »** : `atvload login`.
- **« Limite de certificats »** : `atvload certs`, puis `atvload install MonApp.ipa --revoke <numéro de série>`.
- **Après une mise à jour de tvOS** : si l'installation échoue, refais `atvload pair`.
- **Journal détaillé** : `%APPDATA%\ATVLoad\atvload.log`.

Données : `%APPDATA%\ATVLoad` (état, copie des IPA) et `%APPDATA%\PlumeImpactor` (appairage, session Apple, certificat).
