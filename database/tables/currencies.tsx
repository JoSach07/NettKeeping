import { getDBConnection, GetResult } from "../dbService";
import { describeError } from '@/utils/userFacingError';

export interface Currency{
    Id: number;
    Code: string;
    Name: string;
    NumberToBasic: number;
    IsActive: boolean;
}

export interface GetCurrencyResult extends GetResult {
    Data: Currency[]
}

export const getCurrencies = async (): Promise<GetCurrencyResult> => {
    const _db = await getDBConnection();
    if(_db){
        try{
            const currencies: Currency[] = await _db.getAllAsync('SELECT * FROM Currencies')
            const response: GetCurrencyResult = {
                Status: "Success",
                Data: currencies
            }

            return response;
        } catch (err){
            const response: GetCurrencyResult = {
                Status: "Error",
                ...describeError(err, 'Unable to load currencies.'),
                Data: []
            }

            return response;
        }
    }else{
        const response: GetCurrencyResult = {
            Status: "Error",
            Message: "Error opening database connection",
            Data: []
        }

        return response;
    }
}
