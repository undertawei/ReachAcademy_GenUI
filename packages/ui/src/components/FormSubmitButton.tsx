'use client';

import { useFormStatus } from 'react-dom';

import { Button, type ButtonProps } from './Button';

export type FormSubmitButtonProps = Omit<ButtonProps, 'type'>;

export function FormSubmitButton({ loading, ...props }: FormSubmitButtonProps) {
  const { pending } = useFormStatus();
  return <Button loading={loading ?? pending} type="submit" {...props} />;
}
