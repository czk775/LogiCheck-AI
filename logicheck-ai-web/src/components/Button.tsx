import type { ButtonHTMLAttributes, ReactNode } from 'react'
import { Icon, type IconName } from './Icon'

export type ButtonVariant = 'default' | 'primary' | 'danger' | 'ghost'

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant
  size?: 'md' | 'small'
  icon?: IconName
  children?: ReactNode
}

const VARIANT_CLASS: Record<ButtonVariant, string> = {
  default: '',
  primary: 'primary',
  danger: 'danger',
  ghost: 'ghost',
}

export function Button({
  variant = 'default',
  size = 'md',
  icon,
  children,
  className = '',
  type = 'button',
  ...rest
}: ButtonProps) {
  const classes = [
    'btn',
    VARIANT_CLASS[variant],
    size === 'small' ? 'small' : '',
    className,
  ]
    .filter(Boolean)
    .join(' ')

  return (
    <button type={type} className={classes} {...rest}>
      {icon ? <Icon name={icon} size={size === 'small' ? 'sm' : 'md'} /> : null}
      {children}
    </button>
  )
}
