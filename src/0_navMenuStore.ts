import { setting } from "./0_persistedSetting";
import {
  empty_nav_order,
  type NavMenuFavorites,
  type NavMenuOrder,
  type NavMenuPersistence,
} from "./0_navMenu";

/// instant's storage for one menu: `<key>.order` and `<key>.favorites`, the
/// same storageSignal path every other setting uses.
export function navMenuStore(key: string): NavMenuPersistence {
  return {
    order: setting<NavMenuOrder>(`${key}.order`, empty_nav_order),
    favorites: setting<NavMenuFavorites>(`${key}.favorites`, []),
  };
}
