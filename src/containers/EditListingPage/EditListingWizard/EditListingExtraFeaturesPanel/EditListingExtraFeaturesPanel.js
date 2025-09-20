importer React depuis 'react';
importer classNames depuis 'classnames';

// Importer les configurations et les modules utilitaires
importer { FormattedMessage } depuis '../../../../util/reactIntl';
importer { LISTING_STATE_DRAFT } depuis '../../../../util/types';
importer { types comme sdkTypes } depuis '../../../../util/sdkLoader';

// Importer des composants partagés
importer { H3, ListingLink } depuis '../../../../components';

// Importer des modules depuis ce répertoire
importer EditListingExtraFeaturesForm depuis './EditListingExtraFeaturesForm';
importer css depuis './EditListingExtraFeaturesPanel.module.css';

const getInitialValues ​​= paramètres => {
  const { liste } = paramètres;
  const { extraFeatures } = liste?.attributes.publicData || {};

  retourner { extraFeatures };
};

const EditListingExtraFeaturesPanel = accessoires => {
  const {
    nom de classe,
    rootClassName,
    inscription,
    désactivé,
    prêt,
    sur Soumettre,
    soumettre le texte du bouton,
    panneau mis à jour,
    mise à jour en cours,
    erreurs,
  } = accessoires;

  const classes = classNames(rootClassName || css.root, className);
  const initialValues ​​= getInitialValues(props);
  const isPublished = liste?.id && liste?.attributes?.state !== LISTING_STATE_DRAFT;
  const unitType = liste?.attributes?.publicData?.unitType;

  retour (
    <div className={classes}>
      <H3 as="h1">
        {est publié ? (
          <Message formaté
            id="EditListingExtraFeaturesPanel.title"
            valeurs={{ listingTitle: <ListingLink listing={listing} />, saut de ligne: <br /> }}
          />
        ) : (
          <Message formaté
            id="EditListingExtraFeaturesPanel.createListingTitle"
            valeurs={{ lineBreak: <br /> }}
          />
        )}
      </H3>
      <Modifier le formulaire de fonctionnalités supplémentaires de la liste
        className={css.form}
        valeursinitiales={valeursinitiales}
        onSubmit={valeurs => {
          const { extraFeatures = '' } = valeurs;

          // Nouvelles valeurs pour les attributs de liste
          const updateValues ​​= {
            données publiques : {
              fonctionnalités supplémentaires
            }
          };
          onSubmit(updateValues);
        }}
        unitType={unitType}
        saveActionMsg={submitButtonText}
        désactivé={désactivé}
        prêt={prêt}
        mis à jour={panelUpdated}
        mise à jourEnProgression={mise à jourEnProgression}
        fetchErrors={erreurs}
      />
    </div>
  );
};

exportation par défaut EditListingExtraFeaturesPanel ;
