import React from 'react';
import classNames from 'classnames';
import { useSelector } from 'react-redux';

import Field, { hasDataInFields } from '../../Field';
import { NamedLink } from '../../../../components';

import SectionContainer from '../SectionContainer';
import css from './SectionHero.module.css';

/**
 * @typedef {Object} FieldComponentConfig
 * @property {ReactNode} component
 * @property {Function} pickValidProps
 */

const SectionHero = props => {
  const {
    sectionId,
    className,
    rootClassName,
    defaultClasses,
    title,
    description,
    appearance,
    callToAction,
    options,
  } = props;

  const fieldComponents = options?.fieldComponents;
  const fieldOptions = { fieldComponents };

  const hasHeaderFields = hasDataInFields([title, description, callToAction], fieldOptions);

  // ✅ Détection connexion utilisateur
  const isAuthenticated = useSelector(state => !!state?.user?.currentUser?.id);

  return (
    <SectionContainer
      id={sectionId}
      className={className}
      rootClassName={classNames(rootClassName || css.root)}
      appearance={appearance}
      options={fieldOptions}
    >
      {hasHeaderFields ? (
        <header className={defaultClasses.sectionDetails}>
          <Field data={title} className={defaultClasses.title} options={fieldOptions} />
          <Field data={description} className={defaultClasses.description} options={fieldOptions} />
          <Field data={callToAction} className={defaultClasses.ctaButton} options={fieldOptions} />

          {/* Bouton visible uniquement si utilisateur non connecté */}
          {!isAuthenticated && (
            <div className={css.signupCtaWrapper}>
              <NamedLink
                name="SignupPage"
                className={classNames(defaultClasses.ctaButton, css.signupCta)}
              >
                Inscrivez-vous !
              </NamedLink>
            </div>
          )}
        </header>
      ) : null}
    </SectionContainer>
  );
};

export default SectionHero;
